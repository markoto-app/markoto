import type Stripe from 'stripe'
import { eq } from 'drizzle-orm'
import { users } from '../db/schema'
import { useDatabase } from './database'
import type { PlanName } from '~~/shared/config/tiers'

// Stripe webhook handlers — pure functions of `(event, config) → DB
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
//     start/end so the Model C billing anchor advances to the new
//     cycle (counter key changes → fresh quota row).
//   - `invoice.payment_failed` — retained for observability; we do
//     NOT downgrade on first failure (Stripe retries automatically).
//     The user's plan stays until the eventual subscription.deleted.

/**
 * Map a Stripe Price ID → our internal plan name. Read from runtime
 * config so ops can swap price IDs without code changes (e.g. annual
 * vs monthly). Unknown price IDs return `null` so the handler can
 * log + skip rather than mis-assign a plan.
 */
export function priceIdToPlan(priceId: string | null | undefined, config: {
  pricePro: string
  priceMax: string
  priceUltra: string
}): PlanName | null {
  if (!priceId) return null
  if (priceId === config.pricePro) return 'pro'
  if (priceId === config.priceMax) return 'max'
  if (priceId === config.priceUltra) return 'ultra'
  return null
}

interface UpdateUserArgs {
  where: { stripeCustomerId?: string, id?: number }
  set: Partial<{
    plan: PlanName
    planValidUntil: Date | null
    stripeCurrentPeriodStart: Date | null
    stripeCustomerId: string | null
    stripeSubscriptionId: string | null
  }>
}

/**
 * One-shot user update by customer id OR by internal user id. Used
 * by every webhook handler. Returns the number of rows matched (0
 * when the customer id doesn't map to a user — logged but not
 * fatal: old customers from prior test runs, deleted accounts, etc.).
 */
async function updateUser(opts: UpdateUserArgs): Promise<number> {
  const db = useDatabase()
  const where = opts.where.id !== undefined
    ? eq(users.id, opts.where.id)
    : eq(users.stripeCustomerId, opts.where.stripeCustomerId!)
  const result = await db.update(users).set(opts.set).where(where).returning({ id: users.id })
  return result.length
}

/**
 * `checkout.session.completed` handler. Fires once per successful
 * checkout. Sets the user's customer_id, subscription_id, plan, and
 * period anchors all at once.
 *
 * Why fetch the subscription here (and not defer to
 * customer.subscription.updated): Stripe fires BOTH events on a
 * successful checkout, and their delivery order is NOT guaranteed.
 * If subscription.updated arrives first, its handler looks up the
 * user via `stripe_customer_id` — which isn't stamped yet because
 * that's THIS handler's job. The update silently drops, and the user
 * sits on Free caps despite paying. By retrieving the subscription
 * synchronously here (indexed by `subscriptionId` from the session
 * object, identified by `client_reference_id` = userId), we apply
 * the full state in one DB write. Subsequent subscription.updated
 * events become idempotent no-ops.
 */
export async function handleCheckoutSessionCompleted(
  event: Stripe.CheckoutSessionCompletedEvent,
  opts: {
    stripe: Stripe
    config: { pricePro: string, priceMax: string, priceUltra: string }
  }
): Promise<{ matched: number, plan: PlanName | null }> {
  const session = event.data.object
  const userId = session.client_reference_id ? Number(session.client_reference_id) : null
  if (!userId || Number.isNaN(userId)) {
    console.warn(`[stripe/webhook] checkout.session.completed with no client_reference_id: session=${session.id}`)
    return { matched: 0, plan: null }
  }
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null
  const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id ?? null
  if (!customerId) {
    console.warn(`[stripe/webhook] checkout.session.completed missing customer: session=${session.id}`)
    return { matched: 0, plan: null }
  }

  // Non-subscription checkouts (e.g. one-off product purchases) have
  // no subscription to read. We still stamp the customer id so
  // future subscription flows can reuse the same customer record.
  if (!subscriptionId) {
    const matched = await updateUser({
      where: { id: userId },
      set: { stripeCustomerId: customerId }
    })
    return { matched, plan: null }
  }

  // Fetch the full subscription. If this fails (Stripe API blip), we
  // throw → webhook returns 500 → Stripe retries with backoff. The
  // DB write below is a single UPDATE so partial-apply isn't a
  // concern — either the whole row updates or nothing does.
  const sub = await opts.stripe.subscriptions.retrieve(subscriptionId)
  const item = sub.items.data[0]
  const priceId = item?.price?.id ?? null
  const plan = priceIdToPlan(priceId, opts.config)
  // Stripe API version `2025-01-27.acacia` (pinned in the client)
  // carries `current_period_start` / `current_period_end` on the
  // subscription ITEM, not the subscription root. Cast because the
  // SDK's root type still exposes them during the transition period.
  const itemWithPeriod = item as unknown as { current_period_start?: number, current_period_end?: number }
  const periodStart = itemWithPeriod?.current_period_start
    ? new Date(itemWithPeriod.current_period_start * 1000)
    : null
  const periodEnd = itemWithPeriod?.current_period_end
    ? new Date(itemWithPeriod.current_period_end * 1000)
    : null

  // If the price maps to no known plan (e.g. price ID rotated but
  // config not updated), still stamp customer/sub ids so we can
  // reconcile manually. Don't set `plan` from a bogus mapping.
  const setFields: UpdateUserArgs['set'] = {
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId
  }
  if (plan) setFields.plan = plan
  if (periodStart) setFields.stripeCurrentPeriodStart = periodStart
  if (periodEnd) setFields.planValidUntil = periodEnd

  const matched = await updateUser({
    where: { id: userId },
    set: setFields
  })
  return { matched, plan }
}

/**
 * `customer.subscription.updated` handler. Triggered for: initial
 * creation, plan changes, `cancel_at_period_end` toggles, period
 * rollover. We use the SAME handler as `customer.subscription.created`
 * because they carry identical shapes.
 *
 * - `plan` ← mapped from the first subscription item's price id
 * - `stripeCurrentPeriodStart` ← `subscription.current_period_start`
 * - `planValidUntil` ← `subscription.current_period_end`
 *
 * Scheduled downgrades (`cancel_at_period_end=true`): we do NOT flip
 * the plan yet — the user keeps their paid tier through period end.
 * The actual downgrade happens on `customer.subscription.deleted`
 * (which fires when the period ends).
 */
export async function handleSubscriptionUpdated(
  event: Stripe.CustomerSubscriptionUpdatedEvent | Stripe.CustomerSubscriptionCreatedEvent,
  config: { pricePro: string, priceMax: string, priceUltra: string }
): Promise<{ matched: number, plan: PlanName | null }> {
  const sub = event.data.object
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id
  const item = sub.items.data[0]
  const priceId = item?.price?.id ?? null
  const plan = priceIdToPlan(priceId, config)
  if (!plan) {
    console.warn(`[stripe/webhook] subscription.${event.type.split('.').pop()} unknown price: ${priceId} (sub=${sub.id})`)
    return { matched: 0, plan: null }
  }
  // API version 2025-01-27.acacia: period fields on item root.
  const itemWithPeriod = item as unknown as { current_period_start?: number, current_period_end?: number }
  const setFields: UpdateUserArgs['set'] = {
    plan,
    stripeSubscriptionId: sub.id
  }
  if (itemWithPeriod?.current_period_start) {
    setFields.stripeCurrentPeriodStart = new Date(itemWithPeriod.current_period_start * 1000)
  }
  if (itemWithPeriod?.current_period_end) {
    setFields.planValidUntil = new Date(itemWithPeriod.current_period_end * 1000)
  }
  const matched = await updateUser({
    where: { stripeCustomerId: customerId },
    set: setFields
  })
  return { matched, plan }
}

/**
 * `customer.subscription.deleted` handler. Revert user to Free and
 * null the Stripe anchor so the billing resolver picks the calendar-
 * month fallback (Model C defensive behaviour).
 *
 * Keep `stripeCustomerId` — future resubscriptions can re-use the
 * same customer on Stripe's side. Null `stripeSubscriptionId` because
 * the subscription no longer exists.
 */
export async function handleSubscriptionDeleted(
  event: Stripe.CustomerSubscriptionDeletedEvent
): Promise<{ matched: number }> {
  const sub = event.data.object
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id
  const matched = await updateUser({
    where: { stripeCustomerId: customerId },
    set: {
      plan: 'free',
      stripeSubscriptionId: null,
      stripeCurrentPeriodStart: null,
      planValidUntil: null
    }
  })
  return { matched }
}

/**
 * `invoice.paid` handler. Fires on subscription renewal. Update the
 * period anchors so Model C's period key advances to the new cycle —
 * the next `ai_usage_period` read/write lands on a fresh row at
 * `used=0`, matching the user's mental model of "I just paid → my
 * quota reset."
 *
 * Skip non-subscription invoices (one-off charges etc.).
 */
export async function handleInvoicePaid(
  event: Stripe.InvoicePaidEvent
): Promise<{ matched: number }> {
  const invoice = event.data.object
  if (!invoice.subscription) {
    // One-off invoice, not a subscription cycle. Nothing to update.
    return { matched: 0 }
  }
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? null
  if (!customerId) return { matched: 0 }
  // `period_start` / `period_end` on the invoice are the new cycle's
  // boundaries — use them directly. Falling back to the subscription
  // object would require an extra API round-trip.
  const periodStart = new Date(invoice.period_start * 1000)
  const periodEnd = new Date(invoice.period_end * 1000)
  const matched = await updateUser({
    where: { stripeCustomerId: customerId },
    set: {
      stripeCurrentPeriodStart: periodStart,
      planValidUntil: periodEnd
    }
  })
  return { matched }
}

/**
 * `invoice.payment_failed` handler. Observability-only — we do NOT
 * downgrade immediately. Stripe retries failed charges for ~3 weeks;
 * if all retries fail, Stripe fires `customer.subscription.deleted`
 * which our handler above catches. Logging here helps operators see
 * which users are in dunning.
 */
export async function handleInvoicePaymentFailed(
  event: Stripe.InvoicePaymentFailedEvent
): Promise<{ matched: number }> {
  const invoice = event.data.object
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? null
  console.warn(`[stripe/webhook] payment failed for customer=${customerId} invoice=${invoice.id} attempt=${invoice.attempt_count}`)
  return { matched: 0 }
}

/**
 * Dispatch a verified event to the matching handler. Returns the
 * handler's result so the HTTP endpoint can log it (for ops telemetry)
 * and respond 200 to Stripe (any non-200 triggers a Stripe retry).
 *
 * `stripe` is the SDK client — only `handleCheckoutSessionCompleted`
 * uses it (to fetch the subscription synchronously, avoiding the
 * ordering race against subscription.updated). Passed explicitly
 * rather than imported so unit tests can inject a mock.
 */
export async function dispatchStripeEvent(
  event: Stripe.Event,
  opts: {
    stripe: Stripe
    config: { pricePro: string, priceMax: string, priceUltra: string }
  }
): Promise<{ handled: boolean, detail?: unknown }> {
  switch (event.type) {
    case 'checkout.session.completed':
      return { handled: true, detail: await handleCheckoutSessionCompleted(event, opts) }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      return { handled: true, detail: await handleSubscriptionUpdated(event, opts.config) }
    case 'customer.subscription.deleted':
      return { handled: true, detail: await handleSubscriptionDeleted(event) }
    case 'invoice.paid':
      return { handled: true, detail: await handleInvoicePaid(event) }
    case 'invoice.payment_failed':
      return { handled: true, detail: await handleInvoicePaymentFailed(event) }
    default:
      // Unhandled events are OK — Stripe sends dozens of types we
      // don't care about. Log + acknowledge so Stripe stops retrying.
      return { handled: false }
  }
}
