import type { H3Event } from 'h3'
import type Stripe from 'stripe'
import * as Sentry from '@sentry/nuxt'
import type { PlanCheckoutResponse } from '~~/shared/contracts/stripe'
import type { BillingInterval, Currency } from '~~/shared/config/pricing'
import { getUserCheckoutBilling, recordOwnPlanChange } from '../../repos/userBilling'
import { apiError } from '../api/apiError'
import { recordPaidTermsAcceptance, requirePaidTermsAccepted } from './paidTerms'
import { useStripeClient } from './stripeClient'
import { findLiveSubscription, changeSubscriptionPrice, livePeriod, paymentPendingError, pendingPayment } from './stripePlanChange'
import { identifyItem, subscriptionCancelAt } from './stripeEvents/stripeObjects'
import { stripeResponseTime } from './stripeEvents/eventAge'
import { stripePriceIdFor } from './stripePrices'
import { requestBaseUrl } from './workspaceStripe'
import { checkoutTaxFields } from './checkoutSession'
import { useEnv } from '~~/shared/env/load'
import { useLogger } from '../platform/logger'
import type { UserScope } from '../../repos/proofs'
import { captureCheckoutStarted } from '../analytics/acquisitionSource'

const log = useLogger('billing')

// Buying or changing Pro (`POST /api/billing/checkout`). Without a live
// subscription it creates a Stripe Checkout Session and returns
// `{ url, sessionId }` for a full-page redirect; with one (upgrade between
// paid tiers) it swaps the price on the EXISTING subscription in place
// (prorated, charged now) and returns `{ updated: true, plan, interval }`.
// Never creates a second concurrent subscription. Without `interval` a live
// subscription keeps its billing period; a new one is monthly.
//
// `client_reference_id = userId` lets the `checkout.session.completed`
// webhook associate the subscription with our user; `customer_email`
// pre-fills the form.

export interface ProCheckoutRequest {
  /** The buyer, acting for themselves. */
  self: UserScope
  /** Absent: keep the live subscription's billing period (a new subscription is monthly). */
  interval: BillingInterval | undefined
  currency: Currency | undefined
  /** The request body: carries the paid-terms acceptance (`requirePaidTermsAccepted`). */
  terms: unknown
}

function customerOrEmailFields(stripeCustomerId: string | null, email: string | null): { customer: string } | { customer_email: string } | Record<string, never> {
  if (stripeCustomerId) return { customer: stripeCustomerId }
  if (email) return { customer_email: email }
  return {}
}

export async function startProCheckout(event: H3Event, request: ProCheckoutRequest): Promise<PlanCheckoutResponse<'pro'>> {
  const { self } = request
  const userId = self.userId
  const plan = 'pro'
  const stripe = useStripeClient()
  if (!stripe) throw apiError('billing/not-configured')

  // Reuse an existing Customer so Stripe shows one continuous history.
  const userRow = await getUserCheckoutBilling(self)
  if (!userRow) throw apiError('resource/not-found')
  const { stripeCustomerId, billingCurrency } = userRow

  // A Stripe customer keeps one currency for life, so a user who paid in EUR
  // can't check out in CHF (Stripe would refuse mid-checkout).
  const currency = request.currency ?? billingCurrency ?? 'eur'
  if (billingCurrency && stripeCustomerId && currency !== billingCurrency) {
    throw apiError('billing/currency-locked', { currency: billingCurrency })
  }
  // Probed before the price is chosen: a request without `interval` means
  // the live subscription's own.
  const liveSub = await probeLiveSubscription(stripe, userId, userRow.stripeSubscriptionId)
  const interval = request.interval
    ?? (liveSub ? (await identifyItem(stripe, liveSub.items.data[0]))?.interval : undefined)
    ?? 'month'
  const priceId = await stripePriceIdFor(stripe, plan, interval, currency)
  if (!priceId) throw apiError('billing/price-unavailable')
  requirePaidTermsAccepted(request.terms)

  // In-place plan change. A Checkout Session in `mode: 'subscription'` ALWAYS
  // creates a NEW subscription, which would leave a user with a live one
  // (monthly <-> annual, or a row the webhook hasn't caught up with) billed
  // twice. So probe the recorded subscription and, when live, swap its price;
  // the `customer.subscription.updated` webhook applies plan, period and
  // LiteLLM budget like a Checkout-born change.
  if (liveSub) {
    // Stripe's time just before the change: an event older than it is of
    // the previous state and must not be applied over what is written
    // below; the change's own event is created after it and applies.
    const changedAt = stripeResponseTime(liveSub)
    const updated = await changeProPriceInPlace(stripe, liveSub, priceId, userId)
    await recordPaidTermsAcceptance(event, self, { kind: 'plan', subject: { type: 'user', id: String(userId) }, item: `${plan}_${interval}` })
    // The payment needs the buyer (3-D Secure, declined card): Stripe keeps
    // the change until its invoice is paid, and the webhook applies it then.
    // Nothing is written here, so the old plan stays until it is paid.
    const pending = pendingPayment(updated)
    if (pending) throw paymentPendingError(pending)
    // Written at once so the profile and pricing pages show the new billing
    // period without waiting for the webhook (which writes the same state).
    // Best-effort: the change is already paid for.
    try {
      await recordOwnPlanChange(self, liveSub.id, { interval, cancelAt: subscriptionCancelAt(updated), period: livePeriod(updated), at: changedAt })
    } catch (e) {
      log.warn('plan change not written locally, the webhook will', { userId, err: e })
    }
    return { updated: true, plan, interval }
  }

  // Only the newest Pro Checkout of a user can still be paid.
  await expireOpenProCheckouts(stripe, { userId, customerId: stripeCustomerId, email: userRow.email })
  try {
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'subscription',
      client_reference_id: String(userId),
      line_items: [{ price: priceId, quantity: 1 }],
      // The webhook routes by customer; metadata names the subject explicitly too.
      metadata: { subject_type: 'user', subject_id: String(userId) },
      subscription_data: { metadata: { subject_type: 'user', subject_id: String(userId) } },
      ...checkoutReturnUrls(event),
      // Existing customer, else email so Stripe creates one.
      ...customerOrEmailFields(stripeCustomerId, userRow.email),
      ...checkoutTaxFields(stripeCustomerId !== null),
      ...promotionCodeFields(interval)
    })
    if (!checkoutSession.url) {
      throw apiError('billing/checkout-failed')
    }
    await recordPaidTermsAcceptance(event, self, { kind: 'plan', subject: { type: 'user', id: String(userId) }, item: `${plan}_${interval}` })
    await captureCheckoutStarted(event, self)
    return { url: checkoutSession.url, sessionId: checkoutSession.id }
  } catch (e) {
    log.error('checkout session creation failed', { userId, err: e })
    Sentry.captureException(e, {
      tags: { component: 'billing', event: 'checkout_create_failed', userId: String(userId) }
    })
    throw apiError('billing/checkout-failed')
  }
}

/** How far back an open Checkout Session can reach: Stripe expires one after 24 h by default. */
const OPEN_SESSION_WINDOW_SECONDS = 24 * 3600
/** Upper bound on the sessions read for a buyer without a customer (pages of 100). */
const OPEN_SESSION_SCAN_LIMIT = 500

/** Who is buying: the Stripe customer, or (first purchase) the email Checkout prefills. */
export interface ProBuyer {
  userId: number
  customerId: string | null
  email: string | null
}

/**
 * A personal plan Checkout of this buyer: never a top-up, never another
 * subject's. Without a customer the email must match too: user ids alone
 * are not unique across the databases that share one Stripe sandbox.
 */
function isOwnProCheckout(session: Stripe.Checkout.Session, buyer: ProBuyer): boolean {
  const id = String(buyer.userId)
  return session.mode === 'subscription'
    && session.client_reference_id === id
    && session.metadata?.subject_type === 'user'
    && session.metadata?.subject_id === id
    && (buyer.customerId !== null || session.customer_email === buyer.email)
}

/**
 * Expire the user's other open Pro Checkout Sessions before a new one is
 * created, so only the newest can still be paid (two tabs or a stale
 * Checkout page would otherwise each buy a subscription). A buyer with a
 * Stripe customer is listed by customer; a first-time buyer has none yet
 * (Checkout creates it from `customer_email`), so the open sessions of the
 * last 24 h are read and matched by `client_reference_id`, metadata and
 * the prefilled email.
 * Best-effort: a failure is logged and the checkout goes on, because the
 * webhook still cancels and refunds a duplicate that slips through
 * (`cancelDuplicateSubscription`).
 */
export async function expireOpenProCheckouts(stripe: Stripe, buyer: ProBuyer, now: Date = new Date()): Promise<number> {
  const { userId, customerId } = buyer
  if (!customerId && !buyer.email) return 0
  let expired = 0
  let scanned = 0
  try {
    const params: Stripe.Checkout.SessionListParams = customerId
      ? { customer: customerId, status: 'open', limit: 100 }
      : { status: 'open', created: { gte: Math.floor(now.getTime() / 1000) - OPEN_SESSION_WINDOW_SECONDS }, limit: 100 }
    for await (const session of stripe.checkout.sessions.list(params)) {
      if (++scanned > OPEN_SESSION_SCAN_LIMIT) break
      if (!isOwnProCheckout(session, buyer)) continue
      if (await expireSession(stripe, session.id)) expired++
    }
  } catch (e) {
    log.warn('open checkouts not expired', { userId, err: e })
    Sentry.captureException(e, { tags: { component: 'billing', event: 'checkout_expire_failed', userId: String(userId) } })
  }
  if (expired > 0) log.info('expired open pro checkouts', { userId, expired })
  return expired
}

async function expireSession(stripe: Stripe, sessionId: string): Promise<boolean> {
  try {
    await stripe.checkout.sessions.expire(sessionId)
    return true
  } catch (e) {
    // Completed or expired in the meantime: nothing left to expire.
    if ((e as { type?: string })?.type === 'StripeInvalidRequestError') return false
    throw e
  }
}

/**
 * Launch promotions are Stripe promotion codes for the first year of Pro
 * yearly, so only a NEW yearly Pro subscription shows the code field.
 * Monthly, in-place plan changes, top-ups and workspace checkouts never
 * do: a code there would discount something no promotion was meant for.
 * Managed Payments supports `allow_promotion_codes`. Which codes exist
 * and what they cover (product, duration, expiry) is set in Stripe.
 */
function promotionCodeFields(interval: BillingInterval): { allow_promotion_codes: true } | Record<string, never> {
  return interval === 'year' ? { allow_promotion_codes: true } : {}
}

async function probeLiveSubscription(stripe: Stripe, userId: number, subscriptionId: string | null): Promise<Stripe.Subscription | null> {
  try {
    return await findLiveSubscription(stripe, subscriptionId)
  } catch (e) {
    log.error('subscription probe failed', { userId, err: e })
    Sentry.captureException(e, {
      tags: { component: 'billing', event: 'subscription_probe_failed', userId: String(userId) }
    })
    // Fail CLOSED: going to Checkout without seeing the existing subscription
    // is how double-billing happens.
    throw apiError('billing/subscription-check-failed')
  }
}

async function changeProPriceInPlace(stripe: Stripe, liveSub: Stripe.Subscription, priceId: string, userId: number): Promise<Stripe.Subscription> {
  const current = liveSub.items.data[0]?.price
  if (current?.id === priceId) {
    throw apiError('billing/already-on-plan')
  }
  try {
    return await changeSubscriptionPrice(stripe, liveSub, priceId)
  } catch (e) {
    log.error('in-place plan change failed', { userId, err: e })
    Sentry.captureException(e, {
      tags: { component: 'billing', event: 'plan_change_failed', userId: String(userId) }
    })
    // A declined payment does not land here (`pending_if_incomplete` keeps
    // the change pending); this is Stripe refusing the change itself.
    throw apiError('billing/plan-change-failed')
  }
}

/**
 * `success_url` / `cancel_url`, built from the Origin (always sent on POST)
 * with Host as fallback; both survive Traefik. Stripe substitutes
 * `{CHECKOUT_SESSION_ID}` itself, so don't URL-encode the placeholder.
 */
function checkoutReturnUrls(event: H3Event): { success_url: string, cancel_url: string } {
  const env = useEnv()
  const base = requestBaseUrl(event)
  return {
    success_url: base + (env.billing.stripeSuccessUrl || '/pricing?checkout=success&session={CHECKOUT_SESSION_ID}'),
    cancel_url: base + (env.billing.stripeCancelUrl || '/pricing?checkout=cancelled')
  }
}
