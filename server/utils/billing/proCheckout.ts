import type { H3Event } from 'h3'
import type Stripe from 'stripe'
import * as Sentry from '@sentry/nuxt'
import type { PlanCheckoutResponse } from '~~/shared/contracts/stripe'
import type { BillingInterval, Currency } from '~~/shared/config/pricing'
import { getUserCheckoutBilling, recordOwnPlanChange } from '../../repos/userBilling'
import { apiError } from '../api/apiError'
import { recordPaidTermsAcceptance, requirePaidTermsAccepted } from './paidTerms'
import { useStripeClient } from './stripeClient'
import { findLiveSubscription, changeSubscriptionPrice, livePeriod } from './stripePlanChange'
import { identifyItem, subscriptionCancelAt } from './stripeEvents/stripeObjects'
import { stripePriceIdFor } from './stripePrices'
import { requestBaseUrl } from './workspaceStripe'
import { checkoutTaxFields } from './checkoutSession'
import { useEnv } from '~~/shared/env/load'
import { useLogger } from '../platform/logger'
import type { UserScope } from '../../repos/proofs'

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
    const updated = await changeProPriceInPlace(stripe, liveSub, priceId, userId)
    // Written at once so the profile and pricing pages show the new billing
    // period without waiting for the webhook (which writes the same state).
    // Best-effort: the change is already paid for.
    try {
      await recordOwnPlanChange(self, liveSub.id, { interval, cancelAt: subscriptionCancelAt(updated), period: livePeriod(updated) })
    } catch (e) {
      log.warn('plan change not written locally, the webhook will', { userId, err: e })
    }
    await recordPaidTermsAcceptance(event, self, { kind: 'plan', subject: { type: 'user', id: String(userId) }, item: `${plan}_${interval}` })
    return { updated: true, plan, interval }
  }

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
      ...checkoutTaxFields(stripeCustomerId !== null)
    })
    if (!checkoutSession.url) {
      throw apiError('billing/checkout-failed')
    }
    await recordPaidTermsAcceptance(event, self, { kind: 'plan', subject: { type: 'user', id: String(userId) }, item: `${plan}_${interval}` })
    return { url: checkoutSession.url, sessionId: checkoutSession.id }
  } catch (e) {
    log.error('checkout session creation failed', { userId, err: e })
    Sentry.captureException(e, {
      tags: { component: 'billing', event: 'checkout_create_failed', userId: String(userId) }
    })
    throw apiError('billing/checkout-failed')
  }
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
    // `error_if_incomplete` surfaces payment failures here, nothing changed.
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
