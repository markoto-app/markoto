// Accounts: identity, plan, LiteLLM key, policy acceptance, deletion state.

import { pgTable, serial, integer, bigint, text, timestamp, index, uniqueIndex, boolean, check, date } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import type { StripeSubscriptionStatus } from '~~/shared/contracts/stripe'

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  githubId: text('github_id').unique(),
  googleId: text('google_id').unique(),
  // Generic OpenID Connect identity. Keyed by the PAIR (issuer, subject):
  // `sub` is only unique per issuer, and the email is never the key.
  // Both set or both null (CHECK below).
  oidcIssuer: text('oidc_issuer'),
  oidcSubject: text('oidc_subject'),
  login: text('login'),
  name: text('name').notNull(),
  email: text('email'),
  // PERSONAL subscription tier: `free` or `pro`. Team / Business are
  // workspace subscriptions (`workspace_subscriptions`). Set by the
  // Stripe webhook when `invoice.paid` / `subscription.updated` lands.
  // See server/utils/AGENTS.md.
  plan: text('plan', { enum: ['free', 'pro'] }).notNull().default('free'),
  // Paid-tier expiry = Stripe's `current_period_end`. NULL for free
  // users (free never lapses). Set by the Stripe webhook; the
  // plan-lapse sweep flips the row back to `free` once past it.
  planValidUntil: timestamp('plan_valid_until', { withTimezone: true }),
  // Stripe's `current_period_start` for paid users, anchors the
  // AI-credits billing period so quota resets on the invoice day, not
  // on the 1st of the calendar month. NULL for free users (they fall
  // back to the calendar-month anchor). Updated on every `invoice.paid`.
  stripeCurrentPeriodStart: timestamp('stripe_current_period_start', { withTimezone: true }),
  stripeCustomerId: text('stripe_customer_id').unique(),
  stripeSubscriptionId: text('stripe_subscription_id').unique(),
  // Currency of the personal subscription. A Stripe customer keeps one
  // currency for life, so checkout refuses a different one (409
  // `billing/currency-locked`). NULL until the first subscription.
  billingCurrency: text('billing_currency', { enum: ['eur', 'chf'] }),
  // Billing period of the personal subscription. NULL for free users and
  // for subscriptions written before the column existed (readers then
  // judge by the period length, `billingIntervalOf`).
  billingInterval: text('billing_interval', { enum: ['month', 'year'] }),
  // When a cancelled subscription ends (Stripe `cancel_at`, or the period
  // end with `cancel_at_period_end`). NULL while it renews.
  planCancelAt: timestamp('plan_cancel_at', { withTimezone: true }),
  // Stripe status of the personal subscription, verbatim. NULL without one
  // (and for subscriptions written before the column existed). `past_due`
  // / `unpaid`: Stripe is retrying a failed payment, the plan still runs.
  subscriptionStatus: text('subscription_status').$type<StripeSubscriptionStatus>(),
  // Stripe's time of the newest subscription state on this row: the
  // `created` of the last applied `customer.subscription.*` event, or the
  // moment the app itself read / changed the subscription. An event older
  // than this is not applied (`stripeEvents/eventAge.ts`).
  subscriptionEventAt: timestamp('subscription_event_at', { withTimezone: true }),
  // Platform chat model the user picked: 'fast' = the instance chat
  // default, 'strong' = NUXT_AI_DEFAULT_CHAT_STRONG_MODEL, only applied
  // while the plan includes `aiStrongModel`. Own keys are unaffected.
  aiModelTier: text('ai_model_tier', { enum: ['fast', 'strong'] }).notNull().default('fast'),
  // LiteLLM virtual-key handle: the single source of truth for the
  // user's AI budget. Every billable AI call goes through
  // `useLitellmForUser(litellmKeyToken)` and LiteLLM enforces the plan's
  // `max_budget`. Lazy-created on first AI use via
  // `ensureUserKey(userId, plan)`; updated by Stripe webhooks on plan
  // changes.
  //
  // The token is encrypted at rest with `NUXT_ENCRYPTION_KEY` (server/utils/platform/secretBox.ts) and only held
  // in memory to build the OpenAI SDK client. `litellmKeyId` is LiteLLM's
  // internal token id, accepted by `/key/info` in place of the token.
  litellmKeyId: text('litellm_key_id').unique(),
  litellmKeyToken: text('litellm_key_token'),
  // Platform-admin flag. Source of truth for `/admin/*` access.
  // A user whose email is in `NUXT_ADMIN_USER_EMAILS` is promoted on
  // their next OAuth login (`upsertOAuthUser`); after that the column is
  // the durable record. Never set it without the user's consent and an
  // `admin.granted` audit row.
  isAdmin: boolean('is_admin').notNull().default(false),
  // Preferred locale for transactional emails and the legal-document
  // fallback. NULL means "never chose, use Accept-Language at send time";
  // don't default to 'en', that erases the difference between "picked
  // English" and "never asked".
  locale: text('locale'),
  // GDPR Art. 8 age confirmation. NULL means "not yet confirmed" and the
  // onboarding gate forces the user through it. Never backfill a value
  // for accounts that were not asked: a default would be a false record.
  ageConfirmedAt: timestamp('age_confirmed_at', { withTimezone: true }),
  // GDPR Art. 17 deletion request: a 30-day grace period during which
  // the user can cancel; `accountDeletionSweep` hard-deletes rows past
  // `deletionGraceUntil`. NULL on both = account is active.
  deletionRequestedAt: timestamp('deletion_requested_at', { withTimezone: true }),
  deletionGraceUntil: timestamp('deletion_grace_until', { withTimezone: true }),
  // Acceptance state for the legal documents. The integer is the version
  // accepted (compared with `shared/legal/versions.ts`; a bump re-prompts).
  // `_locale` records which translation the user saw, in case it drifts
  // from the authoritative English text. Nullable because the DPA only
  // applies to workspace owners.
  tosVersionAccepted: integer('tos_version_accepted'),
  tosVersionAcceptedLocale: text('tos_version_accepted_locale'),
  privacyVersionAccepted: integer('privacy_version_accepted'),
  privacyVersionAcceptedLocale: text('privacy_version_accepted_locale'),
  dpaVersionAccepted: integer('dpa_version_accepted'),
  dpaVersionAcceptedLocale: text('dpa_version_accepted_locale'),
  // Session revocation counter. Every sealed session cookie carries the
  // value current at sign-in (`e`); `resolveValidatedUser` rejects a
  // cookie whose `e` differs. Bumped by "log out everywhere" and by an
  // account-deletion request, which invalidates every outstanding
  // cookie at once (cookies themselves can't be recalled). A cookie
  // without `e` counts as epoch 0.
  sessionEpoch: integer('session_epoch').notNull().default(0),
  // When the user finished or skipped the editor's first-run tour. Kept on
  // the account (not only in localStorage, which sign-out clears) so the
  // tour shows once per user. NULL = not seen yet.
  editorTourDoneAt: timestamp('editor_tour_done_at', { withTimezone: true }),
  // The last UTC day the user made a signed-in request (day only, no
  // time, no history: each day overwrites the previous one). Written at
  // most once per day by session validation; feeds the admin's active-user
  // counts (`docs/contributing/admin-metrics.md`). NULL = not seen since
  // the column exists.
  lastActiveOn: date('last_active_on', { mode: 'string' }),
  // Bumped by a database trigger on every change to the user's personal
  // folders and documents (create, rename, move, delete): open explorers
  // poll it and refetch when it moved (migration 0009).
  explorerVersion: bigint('explorer_version', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  // Partial indexes: the plan-lapse and account-deletion sweeps scan these
  // columns, which are null for most rows.
  index('idx_users_plan_valid_until').on(table.planValidUntil).where(sql`${table.planValidUntil} is not null`),
  index('idx_users_deletion_grace_until').on(table.deletionGraceUntil).where(sql`${table.deletionGraceUntil} is not null`),
  uniqueIndex('uq_users_oidc_identity').on(table.oidcIssuer, table.oidcSubject),
  check('ck_users_oidc_identity_pair', sql`(${table.oidcIssuer} is null) = (${table.oidcSubject} is null)`)
])
