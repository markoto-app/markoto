import { eq } from 'drizzle-orm'
import { recordPaidTermsAcceptance, requirePaidTermsAccepted } from '../../utils/billing/paidTerms'
import * as Sentry from '@sentry/nuxt'
import { users } from '../../db/schema'
import { useDatabase } from '../../utils/platform/database'
import { useStripeClient } from '../../utils/billing/stripeClient'
import { findLiveSubscription, changeSubscriptionPrice } from '../../utils/billing/stripePlanChange'
import { stripePriceIdFor } from '../../utils/billing/stripePrices'
import { startCheckoutBody } from '~~/shared/api/billing'
import { MINUTE_MS } from '~~/shared/config/units'
import { useEnv } from '~~/shared/env/load'
import { useLogger } from '../../utils/platform/logger'

const log = useLogger('billing')

// POST /api/billing/checkout: plan purchase/upgrade. Without a live
// subscription it creates a Stripe Checkout Session and returns
// `{ url, sessionId }` for a full-page redirect; with one (upgrade between paid
// tiers) it swaps the price on the EXISTING subscription in place (prorated,
// charged now) and returns `{ updated: true, plan }`. Never creates a second
// concurrent subscription.
//
// `client_reference_id = userId` lets the `checkout.session.completed` webhook
// associate the subscription with our user; `customer_email` pre-fills the form.
//
// Personal checkout sells Pro only (monthly or annual, EUR or CHF; the Stripe
// price catalogue is server/utils/billing/stripePrices.ts). Team / Business are
// workspace subscriptions bought by a workspace admin.

function customerOrEmailFields(stripeCustomerId: string | null, email: string | null): { customer: string } | { customer_email: string } | Record<string, never> {
  if (stripeCustomerId) return { customer: stripeCustomerId }
  if (email) return { customer_email: email }
  return {}
}

export default defineApiHandler({
  access: allow.user(),
  // Billing off → 404 `billing/disabled` before any Stripe call.
  instance: 'billing',
  body: startCheckoutBody,
  // Every call creates a real Stripe Checkout Session; 10/min is far above any
  // human retry pattern and stops a looping client flooding Stripe.
  rateLimit: { namespace: 'billing-checkout', max: 10, windowMs: MINUTE_MS, key: 'user', error: 'billing/rate-limited' },
  handler: async ({ event, user, body }) => {
    const userId = user.id
    const { plan, interval } = body
    if (plan !== 'pro') throw apiError('billing/workspace-plan')

    const stripe = useStripeClient()
    if (!stripe) throw apiError('billing/not-configured')
    const env = useEnv()

    // Reuse an existing Customer so Stripe shows one continuous history.
    const db = useDatabase()
    const rows = await db.select({
      email: users.email,
      stripeCustomerId: users.stripeCustomerId,
      stripeSubscriptionId: users.stripeSubscriptionId,
      billingCurrency: users.billingCurrency
    }).from(users).where(eq(users.id, userId)).limit(1)
    const userRow = rows[0]
    if (!userRow) throw apiError('resource/not-found')
    const { email, stripeCustomerId, stripeSubscriptionId, billingCurrency } = userRow

    // A Stripe customer keeps one currency for life, so a user who paid in EUR
    // can't check out in CHF (Stripe would refuse mid-checkout).
    const currency = body.currency ?? billingCurrency ?? 'eur'
    if (billingCurrency && stripeCustomerId && currency !== billingCurrency) {
      throw apiError('billing/currency-locked', { currency: billingCurrency })
    }
    const priceId = await stripePriceIdFor(stripe, plan, interval, currency)
    if (!priceId) throw apiError('billing/price-unavailable')
    requirePaidTermsAccepted(body)

    // In-place plan change. A Checkout Session in `mode: 'subscription'` ALWAYS
    // creates a NEW subscription, which would leave a user with a live one
    // (monthly <-> annual, or a row the webhook hasn't caught up with) billed
    // twice. So probe the recorded subscription and, when live, swap its price;
    // the `customer.subscription.updated` webhook applies plan, period and
    // LiteLLM budget like a Checkout-born change.
    let liveSub
    try {
      liveSub = await findLiveSubscription(stripe, stripeSubscriptionId)
    } catch (e) {
      log.error('subscription probe failed', { userId, err: e })
      Sentry.captureException(e, {
        tags: { component: 'billing', event: 'subscription_probe_failed', userId: String(userId) }
      })
      // Fail CLOSED: going to Checkout without seeing the existing subscription
      // is how double-billing happens.
      throw apiError('billing/subscription-check-failed')
    }
    if (liveSub) {
      const current = liveSub.items.data[0]?.price
      if (current?.id === priceId) {
        throw apiError('billing/already-on-plan')
      }
      try {
        await changeSubscriptionPrice(stripe, liveSub, priceId)
      } catch (e) {
        log.error('in-place plan change failed', { userId, err: e })
        Sentry.captureException(e, {
          tags: { component: 'billing', event: 'plan_change_failed', userId: String(userId) }
        })
        // `error_if_incomplete` surfaces payment failures here, nothing changed.
        throw apiError('billing/plan-change-failed')
      }
      // The webhook is the source of truth for users.plan; the client may briefly
      // read the old plan until it lands.
      await recordPaidTermsAcceptance(event, userId, { kind: 'plan', subject: { type: 'user', id: String(userId) }, item: `${plan}_${interval}` })
      return { updated: true, plan }
    }

    // `success_url` / `cancel_url` are built from the Origin (always sent on POST)
    // with Host as fallback; both survive Traefik. Stripe substitutes
    // `{CHECKOUT_SESSION_ID}` itself, so don't URL-encode the placeholder.
    const originHeader: string | undefined = getRequestHeader(event, 'origin')
    const hostHeader: string | undefined = getRequestHeader(event, 'host')
    const origin = originHeader ?? hostHeader ?? ''
    const base = origin.startsWith('http') ? origin : `https://${origin}`
    const successUrl = base + (env.billing.stripeSuccessUrl || '/pricing?checkout=success&session={CHECKOUT_SESSION_ID}')
    const cancelUrl = base + (env.billing.stripeCancelUrl || '/pricing?checkout=cancelled')

    // Stripe Tax is opt-in via NUXT_STRIPE_AUTOMATIC_TAX=1: `automatic_tax`
    // hard-errors unless Stripe Tax is activated and an origin address is set in
    // the dashboard. With an existing customer Stripe also needs
    // `customer_update` to save the collected address/name back.
    // `tax_id_collection` lets B2B customers enter a VAT id (EU reverse charge).
    const taxEnabled = ['1', 'true', 'yes'].includes(String(env.billing.stripeAutomaticTax || '').toLowerCase())
    const taxFields = taxEnabled
      ? {
          automatic_tax: { enabled: true },
          billing_address_collection: 'required' as const,
          tax_id_collection: { enabled: true },
          ...(stripeCustomerId ? { customer_update: { address: 'auto' as const, name: 'auto' as const } } : {})
        }
      : {}

    try {
      const checkoutSession = await stripe.checkout.sessions.create({
        mode: 'subscription',
        client_reference_id: String(userId),
        line_items: [{ price: priceId, quantity: 1 }],
        // The webhook routes by customer; metadata names the subject explicitly too.
        metadata: { subject_type: 'user', subject_id: String(userId) },
        subscription_data: { metadata: { subject_type: 'user', subject_id: String(userId) } },
        success_url: successUrl,
        cancel_url: cancelUrl,
        // Existing customer, else email so Stripe creates one.
        ...customerOrEmailFields(stripeCustomerId, email),
        ...taxFields
      })
      if (!checkoutSession.url) {
        throw apiError('billing/checkout-failed')
      }
      await recordPaidTermsAcceptance(event, userId, { kind: 'plan', subject: { type: 'user', id: String(userId) }, item: `${plan}_${interval}` })
      return { url: checkoutSession.url, sessionId: checkoutSession.id }
    } catch (e) {
      log.error('checkout session creation failed', { userId, err: e })
      Sentry.captureException(e, {
        tags: { component: 'billing', event: 'checkout_create_failed', userId: String(userId) }
      })
      throw apiError('billing/checkout-failed')
    }
  }
})
