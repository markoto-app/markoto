// Subscriptions, AI credit top-ups, Stripe webhook bookkeeping and the paid-plans waitlist.

import { pgTable, serial, integer, text, timestamp, primaryKey, index, jsonb, boolean, doublePrecision } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import type { OrderSensitiveStripeEvent, StripeSubscriptionStatus } from '~~/shared/contracts/stripe'
import { users } from './users'
import { workspaces } from './workspaces'

// Team / Business subscription of a workspace. One row
// per workspace that ever had one; Stripe drives every column through the
// webhook. `resolveWorkspacePlan` (server/utils/billing/entitlements.ts)
// counts a row only while billing is on, `status` is live and
// `valid_until` is in the future; otherwise the workspace falls back to
// its creator's personal plan.
export const workspaceSubscriptions = pgTable('workspace_subscriptions', {
  workspaceId: text('workspace_id').primaryKey().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  plan: text('plan', { enum: ['team', 'business'] }).notNull(),
  // Paid seats. Members + open invitations may not exceed it.
  seats: integer('seats').notNull(),
  // Stripe subscription status, verbatim (active, trialing, past_due,
  // canceled, unpaid, incomplete, incomplete_expired, paused).
  status: text('status').$type<StripeSubscriptionStatus>().notNull(),
  // The member who pays and manages billing. SET NULL when their account
  // is deleted; the account-deletion flow hands the role to the
  // longest-serving workspace admin first.
  billingAdminId: integer('billing_admin_id').references(() => users.id, { onDelete: 'set null' }),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id').unique(),
  currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
  validUntil: timestamp('valid_until', { withTimezone: true }),
  // When a cancelled subscription ends (Stripe `cancel_at`, or the period
  // end with `cancel_at_period_end`). NULL while it renews.
  cancelAt: timestamp('cancel_at', { withTimezone: true }),
  // Stripe's time of the newest subscription state on this row (see
  // `users.subscription_event_at`): an older event is not applied.
  subscriptionEventAt: timestamp('subscription_event_at', { withTimezone: true }),
  // LiteLLM team holding the workspace's pooled AI budget.
  litellmTeamId: text('litellm_team_id'),
  // Seat changes inside the current LiteLLM budget window (30 days).
  // Added seats are charged pro rata, so they unlock budget only for the
  // days left in the window; removed seats were paid for the whole
  // window, so their budget stays until it ends. The pooled AI budget
  // counts `seats + budget_seat_adjust` seats until
  // `budget_seat_adjust_until` (the window end), then `seats` again
  // (`workspaceBilling.ts#budgetSeats`).
  budgetSeatAdjust: doublePrecision('budget_seat_adjust').notNull().default(0),
  budgetSeatAdjustUntil: timestamp('budget_seat_adjust_until', { withTimezone: true }),
  // Stripe customers keep one currency for life.
  currency: text('currency', { enum: ['eur', 'chf'] }).notNull().default('eur'),
  interval: text('interval', { enum: ['month', 'year'] }).notNull().default('month'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('idx_workspace_subscriptions_billing_admin').on(table.billingAdminId),
  index('idx_workspace_subscriptions_customer').on(table.stripeCustomerId)
])

// AI credit top-ups: one row per paid top-up, for a
// user (Pro) or a workspace (Team / Business). `subject_id` is the user
// id or the workspace id as text (no FK: two subject kinds; account and
// workspace deletion delete the rows explicitly). `remaining_usd` goes
// down as the subject's AI spend passes its plan budget (monthly
// settlement, `server/utils/billing/aiCredits.ts`) and with refunds; a grant
// expires 12 months after purchase. `stripe_payment_intent_id` is unique
// so a repeated webhook adds nothing.
export const aiCreditGrants = pgTable('ai_credit_grants', {
  id: serial('id').primaryKey(),
  subjectType: text('subject_type', { enum: ['user', 'workspace'] }).notNull(),
  subjectId: text('subject_id').notNull(),
  pack: text('pack').notNull(),
  amountUsd: doublePrecision('amount_usd').notNull(),
  remainingUsd: doublePrecision('remaining_usd').notNull(),
  refundedUsd: doublePrecision('refunded_usd').notNull().default(0),
  // What was paid, in the currency's minor units (cents / Rappen).
  amountPaid: integer('amount_paid').notNull(),
  currency: text('currency', { enum: ['eur', 'chf'] }).notNull(),
  stripePaymentIntentId: text('stripe_payment_intent_id').notNull().unique(),
  stripeCheckoutSessionId: text('stripe_checkout_session_id'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('idx_ai_credit_grants_subject').on(table.subjectType, table.subjectId)
])

// How much of a subject's credits one calendar month (UTC, LiteLLM's
// monthly budget reset) used: the month's AI spend above the plan
// budget, deducted from the grants once. Lets the settlement run
// repeatedly without deducting twice.
export const aiCreditSettlements = pgTable('ai_credit_settlements', {
  subjectType: text('subject_type', { enum: ['user', 'workspace'] }).notNull(),
  subjectId: text('subject_id').notNull(),
  // 'YYYY-MM'
  period: text('period').notNull(),
  consumedUsd: doublePrecision('consumed_usd').notNull().default(0),
  // The highest plan budget (USD, without credits) the subject had while
  // this month was open, recorded by every settlement run. A closed month
  // is settled against it, never against today's plan (a cancelled plan
  // would otherwise turn the whole month's spend into credit use).
  // NULL = no settlement ran while the month was open.
  planBudgetUsd: doublePrecision('plan_budget_usd'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  primaryKey({ columns: [table.subjectType, table.subjectId, table.period] })
])

// Stripe webhook event-id dedup. Stripe redelivers at least once, with
// the same `event.id`. Plain UPSERT idempotency is not enough: a stale
// redelivery after a manual correction (e.g. plan reset to 'free' for a
// refund) or after cancel-then-resubscribe would clobber newer state.
//
// The INSERT happens in the same transaction as the user-row update; on
// conflict the handler answers 200 + `replayed:true`. Stripe replays
// within ~3 days; rows are kept 90 days for forensics, then pruned by a
// daily sweeper.
export const processedWebhookEvents = pgTable('processed_webhook_events', {
  eventId: text('event_id').primaryKey(),
  type: text('type').notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow()
}, t => [
  index('idx_pwe_processed_at').on(t.processedAt)
])

// Out-of-order webhook stash. Stripe doesn't order deliveries:
// subscription.* events can arrive BEFORE checkout.session.completed,
// while `users.stripe_customer_id` is still null, so a handler keyed on
// it matches nothing. `handleCheckoutSessionCompleted` also fetches the
// live subscription, which masks the drop; don't remove that fetch
// without this stash. Unmatched events are stored by `customerId`, then
// drained in `received_at` order and marked `processed=true` once
// `checkout.session.completed` binds the customer to the user.
//
// A daily sweeper prunes processed rows after 7 days and never-replayed
// rows after 30 (the checkout never landed).
export const pendingStripeEvents = pgTable('pending_stripe_events', {
  // Stripe's event.id: PK, so redelivering a stashed event is a no-op.
  eventId: text('event_id').primaryKey(),
  customerId: text('customer_id').notNull(),
  type: text('type').notNull(),
  // Replayed verbatim through the dispatcher once the customer is bound.
  payload: jsonb('payload').$type<OrderSensitiveStripeEvent>().notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  // True once replayed against a bound user row; kept a week for audit.
  processed: boolean('processed').notNull().default(false),
  processedAt: timestamp('processed_at', { withTimezone: true })
}, t => [
  // Drain: customer_id = $1 AND processed = false ORDER BY received_at.
  index('idx_pse_customer_unprocessed').on(t.customerId, t.processed, t.receivedAt),
  index('idx_pse_received_at').on(t.receivedAt)
])

// Paid-plans waitlist. Only active while billing is OFF and the
// deployment advertises upcoming plans (`NUXT_PLANS_COMING_SOON`). Lawful
// basis: consent (GDPR Art.6(1)(a) / FADP Art.6(6)), see
// `server/legal/lawfulBasis.ts#paid_plans_waitlist`.
//
// Double opt-in: a row is written UNCONFIRMED on signup and only counts
// once `confirmed_at` is set via the emailed confirm link. Unconfirmed
// rows are reaped by `server/utils/privacy/waitlistSweep.ts` after the confirm
// window. Unsubscribe DELETES the row (no suppression list, we hold
// nothing once consent is withdrawn).
//
// Privacy shape:
//   - `email` is normalised (trimmed + lower-cased) so re-signups are
//     idempotent; unique.
//   - Tokens are stored as SHA-256 hashes only; the raw values exist
//     only in the email we send. A DB leak can't be replayed into
//     confirm/unsubscribe actions.
//   - No IP address is stored at all (rate limiting happens in Valkey).
//   - `consent_version` + `consent_text_id` record WHICH consent text
//     the person agreed to (`shared/legal/versions.ts` +
//     the `waitlist.consentLabel` i18n key in the signup locale).
//   - `user_id` is set when a logged-in user signs up; CASCADE so
//     account deletion removes the waitlist entry with the account.
export const waitlistSignups = pgTable('waitlist_signups', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  locale: text('locale').notNull(),
  consentVersion: integer('consent_version').notNull(),
  consentTextId: text('consent_text_id').notNull(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
  // Null once confirmed (the confirm link is single-use).
  confirmTokenHash: text('confirm_token_hash').unique(),
  confirmTokenExpiresAt: timestamp('confirm_token_expires_at', { withTimezone: true }),
  unsubscribeTokenHash: text('unsubscribe_token_hash').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true })
}, table => [
  // Account-deletion cascade + data-export lookup.
  index('idx_waitlist_signups_user').on(table.userId),
  // Sweeper: "unconfirmed rows past their confirm window".
  index('idx_waitlist_signups_unconfirmed').on(table.confirmTokenExpiresAt).where(sql`${table.confirmedAt} IS NULL`)
])
