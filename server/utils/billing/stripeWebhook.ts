import type Stripe from 'stripe'
import { and, eq, isNull, lt, or } from 'drizzle-orm'
import * as Sentry from '@sentry/nuxt'
import { users, processedWebhookEvents, pendingStripeEvents, workspaceSubscriptions } from '../../db/schema'
import { useDatabase } from '../platform/database'
import { isWorkspacePlan, type PersonalPlanName, type PlanName, type WorkspacePlanName } from '~~/shared/config/tiers'
import type { Currency, PriceIdentity } from '~~/shared/config/pricing'
import { identifyStripePrice } from './stripePrices'
import { getPooledWorkspace } from './workspaceBilling'
import { cancelDuplicateWorkspaceSubscription } from './workspaceStripe'
import { findLiveSubscription } from './stripePlanChange'
import { subscriptionGrantsPlan, type WorkspaceSubscriptionRow } from '../../repos/workspaceSubscriptions'
import { ensureWorkspaceTeam, syncAllMemberKeyLimits } from '../litellm/workspaceTeams'
import { notifyWorkspaceAdmins } from '../email/workspaceBillingEmails'
import { insertCreditGrant, refundCreditGrant, type CreditSubject } from '../../repos/aiCreditGrants'
import { recomputeCreditBudget } from './aiCredits'
import { isCurrency, isTopupPackId, topupPack, TOPUP_VALIDITY_MONTHS } from '~~/shared/config/pricing'
import { isOrderSensitiveStripeEvent } from '~~/shared/contracts/stripe'
import { updateUserKeyBudget, resetUserKeySpend } from '../litellm/userKeys'

/** `client_reference_id` prefix of a workspace (Team / Business) checkout. */
export const WORKSPACE_REF_PREFIX = 'workspace:'

// Drizzle's node-postgres transaction handle — same shape as the
// top-level `db` for our usage but typed distinctly. We accept either
// for handler reuse: the dispatcher wraps the whole event in a single
// transaction so the dedup INSERT and the user UPDATE commit together.
//
// `DbOrTx` is whatever drizzle accepts for chained query builders: the
// pool-backed result of `useDatabase()` OR a `tx` argument inside
// `db.transaction(async tx => ...)`. They share the chained-builder
// surface we need; we don't actually narrow further.
type DbOrTx = ReturnType<typeof useDatabase> | Parameters<Parameters<ReturnType<typeof useDatabase>['transaction']>[0]>[0]

// Handlers queue side-effects that must run AFTER the
// surrounding transaction commits — primarily LiteLLM virtual-key
// budget syncs. Calling `updateUserKeyBudget` inline acquires its own
// pool connection while the surrounding TX still holds an exclusive
// lock on the same `users` row, deadlocking until `statement_timeout`
// fires. The dispatcher walks this queue after the TX commits and
// runs each closure best-effort.
type DeferredAfterCommit = (() => Promise<void>)[]

// Stripe webhook handlers — pure functions of `(event, stripe) → DB
// mutation`. Kept separate from the HTTP endpoint so tests can call
// them directly without going through signature verification for
// every case. The endpoint (`server/api/webhooks/stripe.post.ts`)
// does the signature check first and then dispatches here.
//
// Events handled:
//   - `checkout.session.completed` — first subscription signup. We
//     learn the customer_id + subscription_id here and stamp them
//     onto the user row.
//   - `customer.subscription.updated` — plan changes, cancel-at-
//     period-end toggles, period rollover. Idempotent: replay with
//     same data → same state.
//   - `customer.subscription.deleted` — subscription ended (either
//     user cancelled immediately or period-end arrived on a
//     scheduled cancel). Flip plan back to Free + null the stripe
//     anchor so the resolver uses the calendar fallback.
//   - `invoice.paid` — renewal charge succeeded. Update the period
//     start/end so the billing anchor advances to the new cycle.
//   - `invoice.payment_failed` — retained for observability; we do
//     NOT downgrade on first failure (Stripe retries automatically).
//     The user's plan stays until the eventual subscription.deleted.

/**
 * What a subscription's first item sells (plan / interval / currency),
 * via the price catalogue (server/utils/billing/stripePrices.ts): the
 * `NUXT_STRIPE_PRICE_IDS` overrides, then the price's lookup key (always
 * on webhook payloads), then the cached catalogue. `null` = not one of
 * our prices — callers log + skip rather than mis-assign a plan.
 */
async function identifyItem(
  stripe: Stripe | null,
  item: { price?: { id?: string | null, lookup_key?: string | null } | null } | null | undefined
): Promise<PriceIdentity | null> {
  return identifyStripePrice(stripe, item?.price ?? null)
}

/**
 * Unix seconds → Date, for a timestamp field read off a Stripe object
 * whose presence depends on the API version.
 */
function stripeTime(value: unknown): Date | null {
  return typeof value === 'number' && value > 0 ? new Date(value * 1000) : null
}

/**
 * Current billing period of a subscription. API 2025-03-31.basil keeps it
 * on the item (`items.data[].current_period_*`); the pinned
 * 2025-01-27.acacia version has it on the subscription itself. Read both,
 * item first, so the period is never lost to a version difference.
 */
function subscriptionPeriod(sub: Stripe.Subscription): { start: Date | null, end: Date | null } {
  const item = sub.items.data[0]
  const start = item && 'current_period_start' in item ? stripeTime(item.current_period_start) : null
  const end = item && 'current_period_end' in item ? stripeTime(item.current_period_end) : null
  return {
    start: start ?? ('current_period_start' in sub ? stripeTime(sub.current_period_start) : null),
    end: end ?? ('current_period_end' in sub ? stripeTime(sub.current_period_end) : null)
  }
}

/**
 * The subscription an invoice bills, or null for a one-off invoice.
 * basil: `parent.subscription_details.subscription`; acacia (pinned):
 * `invoice.subscription`.
 */
function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const parentRef = invoice.parent?.subscription_details?.subscription
  const ref: unknown = parentRef ?? ('subscription' in invoice ? invoice.subscription : null)
  if (typeof ref === 'string') return ref
  if (ref && typeof ref === 'object' && 'id' in ref && typeof ref.id === 'string') return ref.id
  return null
}

/**
 * The service period an invoice pays for: the latest line-item period.
 * NOT `invoice.period_start/_end` — for a renewal those describe when
 * items could be added (the period just ended), so writing them would
 * set `valid_until` to the renewal moment and end the plan.
 */
function invoiceServicePeriod(invoice: Stripe.Invoice): { start: Date, end: Date } | null {
  let best: { start: Date, end: Date } | null = null
  for (const line of invoice.lines?.data ?? []) {
    const start = stripeTime(line.period?.start)
    const end = stripeTime(line.period?.end)
    if (start && end && (!best || end > best.end)) best = { start, end }
  }
  return best
}

function warnUnknownPrice(where: string, priceId: string | null | undefined, ref: string): void {
  const msg = `[stripe/webhook] ${where} unknown price: ${priceId ?? 'none'} (${ref})`
  console.warn(msg)
  Sentry.captureMessage(msg, { level: 'warning', tags: { component: 'stripeWebhook', event: 'unknown_price' } })
}

/**
 * Who a Stripe customer belongs to. Personal subscriptions use the user's
 * customer (`users.stripe_customer_id`); every Team / Business workspace
 * subscription has its OWN customer (`workspace_subscriptions
 * .stripe_customer_id`), so a customer id names exactly one subject.
 * `null` = not bound yet (the out-of-order stash case).
 */
type CustomerSubject = { kind: 'user', userId: number } | { kind: 'workspace', workspaceId: string }

async function subjectForCustomer(customerId: string, db: DbOrTx): Promise<CustomerSubject | null> {
  const user = await db.select({ id: users.id }).from(users).where(eq(users.stripeCustomerId, customerId)).limit(1)
  if (user[0]) return { kind: 'user', userId: user[0].id }
  const ws = await db.select({ workspaceId: workspaceSubscriptions.workspaceId })
    .from(workspaceSubscriptions)
    .where(eq(workspaceSubscriptions.stripeCustomerId, customerId))
    .limit(1)
  if (ws[0]) return { kind: 'workspace', workspaceId: ws[0].workspaceId }
  return null
}

interface UpdateUserArgs {
  where: { stripeCustomerId?: string, id?: number }
  set: Partial<{
    plan: PersonalPlanName
    planValidUntil: Date | null
    stripeCurrentPeriodStart: Date | null
    stripeCustomerId: string | null
    stripeSubscriptionId: string | null
    billingCurrency: Currency | null
  }>
}

/**
 * One-shot user update by customer id OR by internal user id. Returns
 * the number of rows matched (0 when the customer id doesn't map to a
 * user — logged but not fatal).
 */
async function updateUser(opts: UpdateUserArgs, db?: DbOrTx): Promise<number> {
  const handle = db ?? useDatabase()
  const where = opts.where.id === undefined
    ? eq(users.stripeCustomerId, opts.where.stripeCustomerId!)
    : eq(users.id, opts.where.id)
  const result = await handle.update(users).set(opts.set).where(where).returning({ id: users.id })
  return result.length
}

/**
 * Write a workspace's subscription state from a Stripe subscription
 * (insert on first sight, update after). Seats = the item quantity.
 */
async function upsertWorkspaceSubscriptionFromStripe(
  db: DbOrTx,
  args: {
    workspaceId: string
    sub: Stripe.Subscription
    identity: PriceIdentity & { plan: WorkspacePlanName }
    customerId: string
    billingAdminId?: number | null
  }
): Promise<void> {
  const item = args.sub.items.data[0]
  const period = subscriptionPeriod(args.sub)
  const values = {
    plan: args.identity.plan,
    seats: Math.max(1, item?.quantity ?? 1),
    status: args.sub.status,
    stripeCustomerId: args.customerId,
    stripeSubscriptionId: args.sub.id,
    currentPeriodStart: period.start,
    validUntil: period.end,
    currency: args.identity.currency,
    interval: args.identity.interval,
    updatedAt: new Date()
  }
  const billingAdmin = args.billingAdminId === undefined ? {} : { billingAdminId: args.billingAdminId }
  await db.insert(workspaceSubscriptions)
    .values({ workspaceId: args.workspaceId, ...values, ...billingAdmin })
    .onConflictDoUpdate({ target: workspaceSubscriptions.workspaceId, set: { ...values, ...billingAdmin } })
}

/**
 * The workspace's subscription row when it holds a DIFFERENT subscription
 * than `subscriptionId`, else null. Only one subscription per workspace
 * is tracked; events of any other one must not overwrite it.
 */
async function rowHoldingOtherSubscription(db: DbOrTx, workspaceId: string, subscriptionId: string): Promise<WorkspaceSubscriptionRow | null> {
  const row = (await db.select().from(workspaceSubscriptions)
    .where(eq(workspaceSubscriptions.workspaceId, workspaceId)).limit(1))[0] as WorkspaceSubscriptionRow | undefined
  return row?.stripeSubscriptionId && row.stripeSubscriptionId !== subscriptionId ? row : null
}

/** True when the workspace's row holds `subscriptionId` and it has ended (`canceled`). */
async function isEndedSubscription(db: DbOrTx, workspaceId: string, subscriptionId: string): Promise<boolean> {
  const row = (await db.select({ id: workspaceSubscriptions.stripeSubscriptionId, status: workspaceSubscriptions.status })
    .from(workspaceSubscriptions)
    .where(eq(workspaceSubscriptions.workspaceId, workspaceId)).limit(1))[0]
  return row?.id === subscriptionId && row.status === 'canceled'
}

/**
 * After commit: bring the workspace's LiteLLM team budget (seats ×
 * per-seat) and every member key's default limit in line with the
 * subscription the webhook just wrote. No-op unless entitled. Errors are
 * reported, never thrown — `litellm-key-reconcile` repairs drift.
 */
function deferWorkspaceTeamSync(deferAfterCommit: DeferredAfterCommit | undefined, workspaceId: string): void {
  deferAfterCommit?.push(async () => {
    try {
      const pool = await getPooledWorkspace(workspaceId)
      if (!pool) return
      await ensureWorkspaceTeam(pool)
      await syncAllMemberKeyLimits(pool)
    } catch (e) {
      console.warn(`[stripe/webhook] workspace team sync failed for ${workspaceId}: ${e instanceof Error ? e.message : e}`)
      Sentry.captureException(e, { tags: { component: 'stripeWebhook', event: 'workspace_team_sync_failed', workspaceId } })
    }
  })
}

/**
 * A paid credit top-up: record the grant (once per payment intent)
 * and raise the subject's AI budget after commit. The subject comes from
 * the session metadata our checkout set (`subject_type` / `subject_id`);
 * a personal buyer's first customer id is stamped on the user.
 */
async function handleTopupCheckout(
  session: Stripe.Checkout.Session,
  opts: { db?: DbOrTx, deferAfterCommit?: DeferredAfterCommit }
): Promise<{ matched: number, plan: PlanName | null }> {
  const meta = session.metadata ?? {}
  const pack = meta.pack
  const subjectType = meta.subject_type
  const subjectId = meta.subject_id
  const paymentIntent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null
  const currency = (session.currency ?? '').toLowerCase()
  if (meta.kind !== 'topup' || !isTopupPackId(pack) || (subjectType !== 'user' && subjectType !== 'workspace') || !subjectId || !paymentIntent || !isCurrency(currency)) {
    const msg = `[stripe/webhook] payment checkout that isn't a valid top-up: session=${session.id}`
    console.warn(msg)
    Sentry.captureMessage(msg, { level: 'warning', tags: { component: 'stripeWebhook', event: 'topup_invalid' } })
    return { matched: 0, plan: null }
  }
  // Delayed methods (SEPA Direct Debit, …) complete the Checkout with
  // `unpaid`; the credit is granted on `checkout.session.async_payment_succeeded`.
  if (session.payment_status !== 'paid') return { matched: 0, plan: null }
  const db = opts.db ?? useDatabase()
  const subject: CreditSubject = { type: subjectType, id: subjectId }
  const expiresAt = new Date()
  expiresAt.setUTCMonth(expiresAt.getUTCMonth() + TOPUP_VALIDITY_MONTHS)
  const inserted = await insertCreditGrant({
    subject,
    pack,
    amountUsd: topupPack(pack).creditUsd,
    amountPaid: session.amount_total ?? 0,
    currency,
    stripePaymentIntentId: paymentIntent,
    stripeCheckoutSessionId: session.id,
    expiresAt
  }, db)
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null
  if (subjectType === 'user' && customerId) {
    await db.update(users)
      .set({ stripeCustomerId: customerId, billingCurrency: currency })
      .where(and(eq(users.id, Number(subjectId)), isNull(users.stripeCustomerId)))
  }
  if (inserted) opts.deferAfterCommit?.push(() => recomputeCreditBudget(subject))
  return { matched: inserted ? 1 : 0, plan: null }
}

/**
 * `checkout.session.async_payment_succeeded`: a top-up paid with a
 * delayed method (e.g. SEPA Direct Debit) has been paid — grant it now.
 * `checkout.session.completed` saw `payment_status: 'unpaid'` and
 * granted nothing. Idempotent like every grant (unique payment intent).
 * Subscription Checkouts need nothing here: their state comes from the
 * subscription events.
 */
async function handleCheckoutAsyncPaymentSucceeded(
  event: Stripe.CheckoutSessionAsyncPaymentSucceededEvent,
  opts: { db?: DbOrTx, deferAfterCommit?: DeferredAfterCommit }
): Promise<{ matched: number, plan: PlanName | null }> {
  const session = event.data.object
  if (session.mode !== 'payment') return { matched: 0, plan: null }
  return handleTopupCheckout(session, opts)
}

/**
 * `checkout.session.async_payment_failed`: a delayed top-up payment
 * failed. Nothing was granted; logged for support.
 */
function handleCheckoutAsyncPaymentFailed(event: Stripe.CheckoutSessionAsyncPaymentFailedEvent): { matched: number } {
  const session = event.data.object
  if (session.mode !== 'payment') return { matched: 0 }
  const msg = `[stripe/webhook] delayed top-up payment failed: session=${session.id}`
  console.warn(msg)
  Sentry.captureMessage(msg, { level: 'warning', tags: { component: 'stripeWebhook', event: 'topup_async_payment_failed' } })
  return { matched: 0 }
}

/**
 * `charge.refunded`: a refunded top-up loses the refunded share of its
 * credit (credits already used stay used). Other charges are ignored.
 */
async function handleChargeRefunded(
  event: Stripe.ChargeRefundedEvent,
  db?: DbOrTx,
  deferAfterCommit?: DeferredAfterCommit
): Promise<{ matched: number }> {
  const charge = event.data.object
  const paymentIntent = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id ?? null
  if (!paymentIntent || !(charge.amount > 0)) return { matched: 0 }
  const subject = await refundCreditGrant(paymentIntent, charge.amount_refunded / charge.amount, db ?? useDatabase())
  if (!subject) return { matched: 0 }
  deferAfterCommit?.push(() => recomputeCreditBudget(subject))
  return { matched: 1 }
}

function isWorkspaceIdentity(identity: PriceIdentity | null): identity is PriceIdentity & { plan: WorkspacePlanName } {
  return identity !== null && isWorkspacePlan(identity.plan)
}

/**
 * `checkout.session.completed` handler. Fires once per successful
 * checkout. Binds the Stripe customer + subscription to its subject:
 *   - `client_reference_id = <userId>` → a personal Pro subscription;
 *   - `client_reference_id = workspace:<id>` → a Team / Business
 *     workspace subscription (metadata `billing_admin_id` = who paid).
 *
 * Why fetch the subscription here (and not defer to
 * customer.subscription.updated): Stripe fires BOTH events on a
 * successful checkout, and their delivery order is NOT guaranteed. If
 * subscription.updated arrives first, its handler can't map the customer
 * yet — that is THIS handler's job. By retrieving the subscription
 * synchronously here we apply the full state in one write; later
 * subscription.updated events become idempotent no-ops.
 */
export async function handleCheckoutSessionCompleted(
  event: Stripe.CheckoutSessionCompletedEvent,
  opts: {
    stripe: Stripe
    db?: DbOrTx
    deferAfterCommit?: DeferredAfterCommit
  }
): Promise<{ matched: number, plan: PlanName | null }> {
  const session = event.data.object
  // One-time top-up purchase, not a subscription.
  if (session.mode === 'payment') {
    return handleTopupCheckout(session, opts)
  }
  const ref = session.client_reference_id ?? ''
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null
  const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id ?? null

  if (ref.startsWith(WORKSPACE_REF_PREFIX)) {
    const workspaceId = ref.slice(WORKSPACE_REF_PREFIX.length)
    if (!workspaceId || !customerId || !subscriptionId) {
      const msg = `[stripe/webhook] workspace checkout without workspace / customer / subscription: session=${session.id}`
      console.warn(msg)
      Sentry.captureMessage(msg, { level: 'warning', tags: { component: 'stripeWebhook', event: 'checkout_workspace_incomplete' } })
      return { matched: 0, plan: null }
    }
    const sub = await opts.stripe.subscriptions.retrieve(subscriptionId)
    const identity = await identifyItem(opts.stripe, sub.items.data[0])
    if (!isWorkspaceIdentity(identity)) {
      warnUnknownPrice('checkout (workspace)', sub.items.data[0]?.price?.id, `session=${session.id}`)
      return { matched: 0, plan: null }
    }
    // A second completed Checkout while the first subscription is still
    // live: cancel + refund the new one, keep the first.
    const holder = await rowHoldingOtherSubscription(opts.db ?? useDatabase(), workspaceId, sub.id)
    if (holder && await findLiveSubscription(opts.stripe, holder.stripeSubscriptionId)) {
      await cancelDuplicateWorkspaceSubscription(opts.stripe, sub, workspaceId)
      return { matched: 0, plan: null }
    }
    const adminRaw = Number(session.metadata?.billing_admin_id)
    await upsertWorkspaceSubscriptionFromStripe(opts.db ?? useDatabase(), {
      workspaceId,
      sub,
      identity,
      customerId,
      billingAdminId: Number.isInteger(adminRaw) && adminRaw > 0 ? adminRaw : null
    })
    deferWorkspaceTeamSync(opts.deferAfterCommit, workspaceId)
    return { matched: 1, plan: identity.plan }
  }

  const userId = ref ? Number(ref) : null
  if (!userId || Number.isNaN(userId)) {
    const msg = `[stripe/webhook] checkout.session.completed with no client_reference_id: session=${session.id}`
    console.warn(msg)
    Sentry.captureMessage(msg, {
      level: 'warning',
      tags: { component: 'stripeWebhook', event: 'checkout_missing_client_ref' }
    })
    return { matched: 0, plan: null }
  }
  if (!customerId) {
    const msg = `[stripe/webhook] checkout.session.completed missing customer: session=${session.id}`
    console.warn(msg)
    Sentry.captureMessage(msg, {
      level: 'warning',
      tags: { component: 'stripeWebhook', event: 'checkout_missing_customer' }
    })
    return { matched: 0, plan: null }
  }

  // Non-subscription checkouts (one-off purchases) have no subscription
  // to read. Still stamp the customer id so future subscription flows can
  // reuse the same customer record.
  if (!subscriptionId) {
    const matched = await updateUser({
      where: { id: userId },
      set: { stripeCustomerId: customerId }
    }, opts.db)
    return { matched, plan: null }
  }

  // Fetch the full subscription. If this fails (Stripe API blip), we
  // throw → webhook returns 500 → Stripe retries with backoff.
  const sub = await opts.stripe.subscriptions.retrieve(subscriptionId)
  const item = sub.items.data[0]
  const identity = await identifyItem(opts.stripe, item)
  // A personal customer only ever holds Pro; anything else is logged and
  // the plan left alone (customer/sub ids are still stamped so ops can
  // reconcile).
  const plan: PersonalPlanName | null = identity?.plan === 'pro' ? 'pro' : null
  if (!plan) warnUnknownPrice('checkout', item?.price?.id, `session=${session.id}`)
  const period = subscriptionPeriod(sub)

  const setFields: UpdateUserArgs['set'] = {
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId
  }
  if (plan) setFields.plan = plan
  if (identity) setFields.billingCurrency = identity.currency
  if (period.start) setFields.stripeCurrentPeriodStart = period.start
  if (period.end) setFields.planValidUntil = period.end

  const matched = await updateUser({
    where: { id: userId },
    set: setFields
  }, opts.db)

  // Sync the LiteLLM virtual-key budget to the new plan — deferred until
  // after the surrounding TX commits: calling `updateUserKeyBudget` inline
  // would self-deadlock against the row lock held by the UPDATE above.
  if (plan && opts.deferAfterCommit) {
    opts.deferAfterCommit.push(async () => {
      try {
        await updateUserKeyBudget(userId, plan)
      } catch (e) {
        console.warn(`[stripe/webhook] LiteLLM key budget sync failed (user=${userId} plan=${plan}):`, e instanceof Error ? e.message : e)
        Sentry.captureException(e, {
          tags: { component: 'stripeWebhook', event: 'litellm_key_sync_failed', userId: String(userId) }
        })
      }
    })
  }

  return { matched, plan }
}

/**
 * `customer.subscription.created|updated` handler. Plan changes, seat
 * changes, monthly ↔ annual swaps, `cancel_at_period_end` toggles,
 * period rollover, dunning status. Routed by the customer's subject.
 *
 * Scheduled downgrades (`cancel_at_period_end=true`): the plan stays
 * until `customer.subscription.deleted` fires at period end.
 */
export async function handleSubscriptionUpdated(
  event: Stripe.CustomerSubscriptionUpdatedEvent | Stripe.CustomerSubscriptionCreatedEvent,
  opts: { stripe?: Stripe | null, db?: DbOrTx, deferAfterCommit?: DeferredAfterCommit } = {}
): Promise<{ matched: number, plan: PlanName | null }> {
  const db = opts.db ?? useDatabase()
  const sub = event.data.object
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id
  const item = sub.items.data[0]
  const identity = await identifyItem(opts.stripe ?? null, item)
  const subject = await subjectForCustomer(customerId, db)

  if (subject?.kind === 'workspace') {
    if (!isWorkspaceIdentity(identity)) {
      warnUnknownPrice(`subscription.${event.type.split('.').pop()} (workspace)`, item?.price?.id, `sub=${sub.id}`)
      return { matched: 0, plan: null }
    }
    // Another subscription is the workspace's live one (this is a
    // duplicate being cancelled, or a late event of an old one).
    const holder = await rowHoldingOtherSubscription(db, subject.workspaceId, sub.id)
    if (holder && subscriptionGrantsPlan(holder)) {
      console.warn(`[stripe/webhook] ignoring ${event.type} of ${sub.id}: workspace ${subject.workspaceId} is on ${holder.stripeSubscriptionId}`)
      return { matched: 0, plan: null }
    }
    // A cancelled subscription never comes back in Stripe, so an event
    // that says otherwise is an older one delivered late (a retry after
    // `customer.subscription.deleted`) and must not re-entitle the workspace.
    if (await isEndedSubscription(db, subject.workspaceId, sub.id)) {
      console.warn(`[stripe/webhook] ignoring late ${event.type} of ended subscription ${sub.id} (workspace ${subject.workspaceId})`)
      return { matched: 0, plan: null }
    }
    await upsertWorkspaceSubscriptionFromStripe(db, { workspaceId: subject.workspaceId, sub, identity, customerId })
    deferWorkspaceTeamSync(opts.deferAfterCommit, subject.workspaceId)
    // Cancelled to the period end (portal, or no billing admin left):
    // tell the admins once per subscription + period.
    if (sub.cancel_at_period_end) {
      const end = subscriptionPeriod(sub).end
      const workspaceId = subject.workspaceId
      opts.deferAfterCommit?.push(async () => {
        await notifyWorkspaceAdmins({ workspaceId, kind: 'ending', date: end, onceKey: `ending:${sub.id}:${end?.getTime() ?? 0}` })
      })
    }
    return { matched: 1, plan: identity.plan }
  }

  const plan: PersonalPlanName | null = identity?.plan === 'pro' ? 'pro' : null
  if (!plan) {
    warnUnknownPrice(`subscription.${event.type.split('.').pop()}`, item?.price?.id, `sub=${sub.id}`)
    return { matched: 0, plan: null }
  }
  const period = subscriptionPeriod(sub)
  const setFields: UpdateUserArgs['set'] = {
    plan,
    billingCurrency: identity!.currency
  }
  if (period.start) setFields.stripeCurrentPeriodStart = period.start
  if (period.end) setFields.planValidUntil = period.end
  // Only the user's current subscription (stamped by the checkout) is
  // applied. `customer.subscription.deleted` clears it, so a late event
  // of an ended subscription can't bring Pro back; a new subscription's
  // events that beat its checkout are covered by the checkout, which
  // reads the live subscription.
  const matched = (await db.update(users).set(setFields)
    .where(and(eq(users.stripeCustomerId, customerId), eq(users.stripeSubscriptionId, sub.id)))
    .returning({ id: users.id })).length
  if (matched === 0) {
    console.warn(`[stripe/webhook] ignoring ${event.type} of ${sub.id}: not the customer's current subscription`)
    return { matched: 0, plan: null }
  }

  // Deferred LiteLLM key budget sync (see handleCheckoutSessionCompleted).
  if (opts.deferAfterCommit) {
    opts.deferAfterCommit.push(async () => {
      try {
        const userId = await getUserIdByCustomer(customerId)
        if (userId !== null) {
          await updateUserKeyBudget(userId, plan)
        }
      } catch (e) {
        console.warn(`[stripe/webhook] LiteLLM key budget sync failed (customer=${customerId} plan=${plan}):`, e instanceof Error ? e.message : e)
        Sentry.captureException(e, {
          tags: { component: 'stripeWebhook', event: 'litellm_key_sync_failed', customerId }
        })
      }
    })
  }

  return { matched, plan }
}

/**
 * `customer.subscription.deleted` handler.
 *   - Personal: revert to Free and null the Stripe anchor (the resolver
 *     falls back to the calendar month). `stripeCustomerId` and
 *     `billingCurrency` stay — a resubscription reuses the customer.
 *   - Workspace: mark the subscription `canceled` (the row stays as the
 *     record; `resolveWorkspacePlan` stops granting the plan).
 */
export async function handleSubscriptionDeleted(
  event: Stripe.CustomerSubscriptionDeletedEvent,
  db?: DbOrTx,
  deferAfterCommit?: DeferredAfterCommit
): Promise<{ matched: number }> {
  const handle = db ?? useDatabase()
  const sub = event.data.object
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id
  const subject = await subjectForCustomer(customerId, handle)

  if (subject?.kind === 'workspace') {
    // Only the tracked subscription ends the workspace's plan (not a
    // cancelled duplicate, not an old subscription's late event).
    if (await rowHoldingOtherSubscription(handle, subject.workspaceId, sub.id)) return { matched: 0 }
    const result = await handle.update(workspaceSubscriptions)
      .set({ status: 'canceled', updatedAt: new Date() })
      .where(eq(workspaceSubscriptions.workspaceId, subject.workspaceId))
      .returning({ workspaceId: workspaceSubscriptions.workspaceId })
    // The team + member keys stay (unused while not entitled: members
    // fall back to their personal keys); a resubscription reuses them and
    // workspace deletion removes them (`endWorkspaceBilling`).
    const workspaceId = subject.workspaceId
    deferAfterCommit?.push(async () => {
      await notifyWorkspaceAdmins({ workspaceId, kind: 'ended', onceKey: `ended:${sub.id}` })
    })
    return { matched: result.length }
  }

  const matched = await updateUser({
    where: { stripeCustomerId: customerId },
    set: {
      plan: 'free',
      stripeSubscriptionId: null,
      stripeCurrentPeriodStart: null,
      planValidUntil: null
    }
  }, handle)

  // Drop the LiteLLM key budget to the free-tier value — deferred to
  // post-commit (see handleCheckoutSessionCompleted).
  if (deferAfterCommit) {
    deferAfterCommit.push(async () => {
      try {
        const userId = await getUserIdByCustomer(customerId)
        if (userId !== null) {
          await updateUserKeyBudget(userId, 'free')
          // Un-brick: a user who spent more than the free cap while on a
          // paid plan would otherwise sit over-budget until the monthly
          // budget_duration reset. Reset spend now.
          await resetUserKeySpend(userId)
        }
      } catch (e) {
        console.warn(`[stripe/webhook] LiteLLM key drop-to-free failed (customer=${customerId}):`, e instanceof Error ? e.message : e)
        Sentry.captureException(e, {
          tags: { component: 'stripeWebhook', event: 'litellm_key_sync_failed', customerId }
        })
      }
    })
  }

  return { matched }
}

/** Resolve `users.id` from a Stripe customer id (null if none). */
async function getUserIdByCustomer(customerId: string, db?: DbOrTx): Promise<number | null> {
  const conn = db ?? useDatabase()
  const rows = await conn.select({ id: users.id })
    .from(users)
    .where(eq(users.stripeCustomerId, customerId))
    .limit(1)
  return rows[0]?.id ?? null
}

/**
 * `invoice.paid` handler. A subscription invoice was paid (renewal, or
 * the prorated charge for added seats): advance the period anchors to
 * the service period it paid for (user or workspace). Only ever moves
 * them forward — `customer.subscription.updated` carries the same period
 * and may arrive first, and a late event of an older invoice must not
 * pull `valid_until` back.
 *
 * No LiteLLM spend reset here: spend resets are driven by the key's
 * `budget_duration` (monthly, on the 1st) so every tier — including free,
 * which has no invoice — resets uniformly.
 *
 * Skip non-subscription invoices (one-off charges, top-ups).
 */
export async function handleInvoicePaid(
  event: Stripe.InvoicePaidEvent,
  db?: DbOrTx,
  _deferAfterCommit?: DeferredAfterCommit
): Promise<{ matched: number }> {
  const handle = db ?? useDatabase()
  const invoice = event.data.object
  const subscriptionId = invoiceSubscriptionId(invoice)
  if (!subscriptionId) return { matched: 0 }
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? null
  if (!customerId) return { matched: 0 }
  const period = invoiceServicePeriod(invoice)
  if (!period) return { matched: 0 }

  const subject = await subjectForCustomer(customerId, handle)
  if (subject?.kind === 'workspace') {
    if (await rowHoldingOtherSubscription(handle, subject.workspaceId, subscriptionId)) return { matched: 0 }
    const result = await handle.update(workspaceSubscriptions)
      .set({ currentPeriodStart: period.start, validUntil: period.end, updatedAt: new Date() })
      .where(and(
        eq(workspaceSubscriptions.workspaceId, subject.workspaceId),
        or(isNull(workspaceSubscriptions.validUntil), lt(workspaceSubscriptions.validUntil, period.end))
      ))
      .returning({ workspaceId: workspaceSubscriptions.workspaceId })
    return { matched: result.length }
  }

  const result = await handle.update(users)
    .set({ stripeCurrentPeriodStart: period.start, planValidUntil: period.end })
    .where(and(
      eq(users.stripeCustomerId, customerId),
      eq(users.stripeSubscriptionId, subscriptionId),
      or(isNull(users.planValidUntil), lt(users.planValidUntil, period.end))
    ))
    .returning({ id: users.id })
  return { matched: result.length }
}

/**
 * `invoice.payment_failed` handler. Observability-only — no downgrade
 * on first failure (Stripe retries; the subscription goes `past_due`,
 * which `customer.subscription.updated` records, and eventually
 * `customer.subscription.deleted` if every retry fails).
 */
export async function handleInvoicePaymentFailed(
  event: Stripe.InvoicePaymentFailedEvent,
  db?: DbOrTx,
  deferAfterCommit?: DeferredAfterCommit
): Promise<{ matched: number }> {
  const invoice = event.data.object
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? null
  // Team / Business: Stripe retries for about two weeks; the admins hear
  // about the FIRST failure. Personal plans: Stripe's own dunning
  // emails cover it.
  if (customerId && (invoice.attempt_count ?? 1) <= 1) {
    const subject = await subjectForCustomer(customerId, db ?? useDatabase())
    if (subject?.kind === 'workspace') {
      const workspaceId = subject.workspaceId
      deferAfterCommit?.push(async () => {
        await notifyWorkspaceAdmins({ workspaceId, kind: 'payment_failed', onceKey: `payment_failed:${invoice.id}` })
      })
    }
  }
  const msg = `[stripe/webhook] payment failed for customer=${customerId} invoice=${invoice.id} attempt=${invoice.attempt_count}`
  console.warn(msg)
  Sentry.captureMessage(msg, {
    level: 'warning',
    tags: { component: 'stripeWebhook', event: 'invoice_payment_failed' }
  })
  return { matched: 0 }
}

/**
 * Internal dispatcher — runs an event's handler against the given
 * `db` (top-level pool OR a transaction handle) without doing the
 * dedup INSERT or the out-of-order stash. Used both by the public
 * `dispatchStripeEvent` AND by the drain logic when replaying stashed
 * events for a now-bound customer.
 */
async function runHandler(
  event: Stripe.Event,
  opts: {
    stripe: Stripe
    db: DbOrTx
    deferAfterCommit?: DeferredAfterCommit
  }
): Promise<{ handled: boolean, detail?: unknown }> {
  switch (event.type) {
    case 'checkout.session.completed':
      return { handled: true, detail: await handleCheckoutSessionCompleted(event, opts) }
    case 'checkout.session.async_payment_succeeded':
      return { handled: true, detail: await handleCheckoutAsyncPaymentSucceeded(event, opts) }
    case 'checkout.session.async_payment_failed':
      return { handled: true, detail: handleCheckoutAsyncPaymentFailed(event) }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      return { handled: true, detail: await handleSubscriptionUpdated(event, opts) }
    case 'customer.subscription.deleted':
      return { handled: true, detail: await handleSubscriptionDeleted(event, opts.db, opts.deferAfterCommit) }
    case 'invoice.paid':
      return { handled: true, detail: await handleInvoicePaid(event, opts.db, opts.deferAfterCommit) }
    case 'charge.refunded':
      return { handled: true, detail: await handleChargeRefunded(event, opts.db, opts.deferAfterCommit) }
    case 'invoice.payment_failed':
      return { handled: true, detail: await handleInvoicePaymentFailed(event, opts.db, opts.deferAfterCommit) }
    default:
      // Unhandled events are OK — Stripe sends dozens of types we
      // don't care about. Log + acknowledge so Stripe stops retrying.
      return { handled: false }
  }
}

/**
 * Pull the customer id off any of the event types that key on it.
 * Returns null for event shapes that don't carry one (e.g. unknown
 * event types). Used to (a) detect out-of-order subscription events
 * and (b) drain the pending-events stash on checkout binding.
 */
function extractCustomerId(event: Stripe.Event): string | null {
  // Cast through `unknown` because Stripe.Event.data.object is a giant
  // discriminated union (every Stripe object type) — we only care about
  // the ones that carry a `customer` field, and we already gate this
  // function behind a type-name check at the call site.
  const obj = (event.data as unknown as { object?: Record<string, unknown> })?.object
  if (!obj) return null
  const cust = (obj as { customer?: string | { id?: string } | null }).customer
  if (typeof cust === 'string') return cust
  if (cust && typeof cust === 'object' && typeof cust.id === 'string') return cust.id
  return null
}

/**
 * Drain stashed orphan events for a customer that's now bound to a
 * user or a workspace subscription. Called from inside `dispatchStripeEvent` after a
 * `checkout.session.completed` finishes. Each stashed payload is
 * replayed through `runHandler` against the same transaction; rows
 * are then flipped to `processed=true` (kept for a week so ops can
 * audit what was late-applied).
 */
async function drainPendingEvents(
  customerId: string,
  opts: {
    stripe: Stripe
    db: DbOrTx
    deferAfterCommit?: DeferredAfterCommit
  }
): Promise<number> {
  const rows = await opts.db.select({
    eventId: pendingStripeEvents.eventId,
    payload: pendingStripeEvents.payload
  })
    .from(pendingStripeEvents)
    .where(and(
      eq(pendingStripeEvents.customerId, customerId),
      eq(pendingStripeEvents.processed, false)
    ))
    .orderBy(pendingStripeEvents.receivedAt)

  for (const row of rows) {
    try {
      await runHandler(row.payload as Stripe.Event, opts)
      await opts.db.update(pendingStripeEvents)
        .set({ processed: true, processedAt: new Date() })
        .where(eq(pendingStripeEvents.eventId, row.eventId))
      console.log(`[stripe/webhook] drained stashed event ${row.eventId} for customer ${customerId}`)
    } catch (e) {
      // Don't propagate — one bad stashed event shouldn't block the
      // rest from replaying. Sentry capture so ops sees it; the row
      // stays processed=false and the daily sweep eventually reaps it.
      console.warn(`[stripe/webhook] drain failed for stashed event ${row.eventId}:`, e instanceof Error ? e.message : e)
      Sentry.captureException(e, {
        tags: { component: 'stripeWebhook', event: 'stash_drain_failed', stripeEventId: row.eventId }
      })
    }
  }
  return rows.length
}

/**
 * Dispatch a verified event to the matching handler. Returns the
 * handler's result so the HTTP endpoint can log it (for ops telemetry)
 * and respond 200 to Stripe (any non-200 triggers a Stripe retry).
 *
 * Replay protection: BEFORE running the handler we INSERT into
 * `processed_webhook_events`. On conflict (event.id already present)
 * we short-circuit — Stripe is satisfied by 200 and stops retrying,
 * but we don't re-apply the event's UPDATEs. This preserves manual
 * ops corrections that landed between the original delivery and a
 * retried redelivery.
 *
 * Out-of-order stash: subscription.* / invoice.* events that arrive
 * BEFORE checkout.session.completed (i.e. before
 * `users.stripe_customer_id` is set) match zero rows. We stash the
 * full payload in `pending_stripe_events` and drain on the eventual
 * checkout. Defensive belt-and-braces around the live-fetch in
 * `handleCheckoutSessionCompleted` — if anyone removes that
 * subscriptions.retrieve, the stash keeps state convergent.
 *
 * Everything runs in ONE transaction so a crash mid-handler rolls
 * back BOTH the user UPDATE and the dedup INSERT — Stripe's retry
 * then succeeds.
 *
 * `stripe` is the SDK client — only `handleCheckoutSessionCompleted`
 * uses it. Passed explicitly so unit tests can inject a mock.
 */
export async function dispatchStripeEvent(
  event: Stripe.Event,
  opts: {
    stripe: Stripe
  }
): Promise<{ handled: boolean, detail?: unknown, replayed?: boolean, stashed?: boolean }> {
  const db = useDatabase()
  // Handlers push LiteLLM key-sync closures here (instead of
  // running them inline) — the surrounding TX holds an exclusive lock
  // on the user row, and `updateUserKeyBudget` opens its own pool
  // connection to UPDATE the same row. We flush these AFTER the TX
  // commits so the lock has been released.
  const deferAfterCommit: DeferredAfterCommit = []
  const result = await db.transaction(async (tx: DbOrTx) => {
    // Step 1: dedup. Atomic INSERT with ON CONFLICT DO NOTHING; if
    // the returning array is empty, this event.id has been processed
    // before. Short-circuit so the row stays at whatever state it's
    // in (including any out-of-band ops correction).
    const inserted = await tx.insert(processedWebhookEvents)
      .values({ eventId: event.id, type: event.type })
      .onConflictDoNothing({ target: processedWebhookEvents.eventId })
      .returning({ eventId: processedWebhookEvents.eventId })

    if (inserted.length === 0) {
      console.log(`[stripe/webhook] replay short-circuited for event ${event.id}`)
      return { handled: true, replayed: true }
    }

    // Step 2: out-of-order stash. For subscription.* / invoice.*
    // events that arrive BEFORE the user is bound to a Stripe
    // customer, store the full payload and bail. The eventual
    // checkout.session.completed drains the stash. The set of
    // order-sensitive types is owned by `shared/contracts/stripe.ts`
    // so the stash matches the dispatcher's switch table.
    if (isOrderSensitiveStripeEvent(event)) {
      const customerId = extractCustomerId(event)
      if (customerId) {
        // Probe: does a user or a workspace subscription own this
        // customer id? If not, stash.
        if (await subjectForCustomer(customerId, tx) === null) {
          await tx.insert(pendingStripeEvents)
            .values({
              eventId: event.id,
              customerId,
              type: event.type,
              payload: event
            })
            .onConflictDoNothing({ target: pendingStripeEvents.eventId })
          console.log(`[stripe/webhook] stashed out-of-order ${event.type} for unbound customer ${customerId} (event ${event.id})`)
          return { handled: true, stashed: true }
        }
      }
    }

    // Step 3: dispatch the event normally.
    const result = await runHandler(event, { ...opts, db: tx, deferAfterCommit })

    // Step 4: if this was a checkout, drain any stashed events that
    // were waiting for this customer to be bound.
    if (event.type === 'checkout.session.completed') {
      const customerId = extractCustomerId(event)
      if (customerId) {
        const drained = await drainPendingEvents(customerId, { ...opts, db: tx, deferAfterCommit })
        if (drained > 0) {
          const detail = result.detail ?? {}
          return { ...result, detail: { ...detail, drained } }
        }
      }
    }

    return result
  })

  // Flush deferred LiteLLM key syncs. Each closure already swallows its
  // own errors + reports to Sentry — running them sequentially keeps
  // the side-effect ordering predictable for tests and ops.
  for (const fn of deferAfterCommit) {
    await fn()
  }

  return result
}
