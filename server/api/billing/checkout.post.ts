import { eq } from 'drizzle-orm'
import { recordPaidTermsAcceptance, requirePaidTermsAccepted } from '../../utils/billing/paidTerms'
import * as Sentry from '@sentry/nuxt'
import { users } from '../../db/schema'
import { useDatabase } from '../../utils/platform/database'
import { useStripeClient } from '../../utils/billing/stripeClient'
import { findLiveSubscription, changeSubscriptionPrice } from '../../utils/billing/stripePlanChange'
import { assertBillingEnabled } from '../../utils/billing/billingMode'
import { stripePriceIdFor } from '../../utils/billing/stripePrices'
import { isBillingInterval, isCurrency } from '~~/shared/config/pricing'

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

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  // Billing off → 404 `billing/disabled` before any Stripe call.
  assertBillingEnabled()
  const userId = session.user.id

  // Every call creates a real Stripe Checkout Session; 10/min is far above any
  // human retry pattern and stops a looping client flooding Stripe.
  if (!(await checkRateLimit('billing-checkout', String(userId), 10, 60_000))) {
    throw createError({
      statusCode: 429,
      message: 'Too many checkout attempts. Try again in a minute.',
      data: { code: 'billing/rate-limited', messageKey: 'error.rateLimited' }
    })
  }

  const body = await readBody<{ plan?: unknown, interval?: unknown, currency?: unknown }>(event)
  const requestedPlan = typeof body?.plan === 'string' ? body.plan : ''
  if (requestedPlan === 'team' || requestedPlan === 'business') {
    throw createError({
      statusCode: 400,
      message: 'Team and Business are bought for a workspace, from its billing settings.',
      data: { code: 'billing/workspace-plan' }
    })
  }
  if (requestedPlan !== 'pro') {
    throw createError({ statusCode: 400, message: 'Invalid plan. Must be pro.' })
  }
  const plan = requestedPlan
  const interval = body?.interval === undefined ? 'month' : body.interval
  if (!isBillingInterval(interval)) {
    throw createError({ statusCode: 400, message: 'Invalid interval. Must be month or year.' })
  }
  if (body?.currency !== undefined && !isCurrency(body.currency)) {
    throw createError({ statusCode: 400, message: 'Invalid currency. Must be eur or chf.' })
  }

  const stripe = useStripeClient()
  if (!stripe) {
    throw createError({ statusCode: 503, message: 'Billing is not configured. Contact support.' })
  }
  const config = useRuntimeConfig()

  // Reuse an existing Customer so Stripe shows one continuous history.
  const db = useDatabase()
  const rows = await db.select({
    email: users.email,
    stripeCustomerId: users.stripeCustomerId,
    stripeSubscriptionId: users.stripeSubscriptionId,
    billingCurrency: users.billingCurrency
  }).from(users).where(eq(users.id, userId)).limit(1)
  const userRow = rows[0]
  if (!userRow) {
    throw createError({ statusCode: 404, message: 'User not found' })
  }
  const { email, stripeCustomerId, stripeSubscriptionId, billingCurrency } = userRow

  // A Stripe customer keeps one currency for life, so a user who paid in EUR
  // can't check out in CHF (Stripe would refuse mid-checkout).
  const currency = isCurrency(body?.currency) ? body.currency : (billingCurrency ?? 'eur')
  if (billingCurrency && stripeCustomerId && currency !== billingCurrency) {
    throw createError({
      statusCode: 409,
      message: `Your subscription is billed in ${billingCurrency.toUpperCase()}; it can't switch currency.`,
      data: { code: 'billing/currency-locked', currency: billingCurrency, messageKey: 'pricing.currencyLocked' }
    })
  }
  const priceId = await stripePriceIdFor(stripe, plan, interval, currency)
  if (!priceId) {
    throw createError({ statusCode: 503, message: `No Stripe price is set up for ${plan} (${interval}, ${currency.toUpperCase()}).` })
  }
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
    const msg = e instanceof Error ? e.message : 'Stripe error'
    console.error('[billing/checkout] subscription probe failed:', msg)
    Sentry.captureException(e, {
      tags: { component: 'billing', event: 'subscription_probe_failed', userId: String(userId) }
    })
    // Fail CLOSED: going to Checkout without seeing the existing subscription
    // is how double-billing happens.
    throw createError({ statusCode: 502, message: 'Could not verify your current subscription. Please try again.' })
  }
  if (liveSub) {
    const current = liveSub.items.data[0]?.price
    if (current?.id === priceId) {
      throw createError({ statusCode: 409, message: `You are already on the ${plan} plan (${interval === 'year' ? 'annual' : 'monthly'}).` })
    }
    try {
      await changeSubscriptionPrice(stripe, liveSub, priceId)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Stripe error'
      console.error('[billing/checkout] in-place plan change failed:', msg)
      Sentry.captureException(e, {
        tags: { component: 'billing', event: 'plan_change_failed', userId: String(userId) }
      })
      // `error_if_incomplete` surfaces payment failures here, nothing changed.
      throw createError({ statusCode: 502, message: `Could not change your plan: ${msg}` })
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
  const successUrl = base + (config.stripe.successUrl || '/pricing?checkout=success&session={CHECKOUT_SESSION_ID}')
  const cancelUrl = base + (config.stripe.cancelUrl || '/pricing?checkout=cancelled')

  // Stripe Tax is opt-in via NUXT_STRIPE_AUTOMATIC_TAX=1: `automatic_tax`
  // hard-errors unless Stripe Tax is activated and an origin address is set in
  // the dashboard. With an existing customer Stripe also needs
  // `customer_update` to save the collected address/name back.
  // `tax_id_collection` lets B2B customers enter a VAT id (EU reverse charge).
  const taxEnabled = ['1', 'true', 'yes'].includes(String(config.stripe.automaticTax || '').toLowerCase())
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
      throw createError({ statusCode: 502, message: 'Stripe did not return a Checkout URL' })
    }
    await recordPaidTermsAcceptance(event, userId, { kind: 'plan', subject: { type: 'user', id: String(userId) }, item: `${plan}_${interval}` })
    return { url: checkoutSession.url, sessionId: checkoutSession.id }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Stripe error'
    console.error('[billing/checkout] Stripe rejected the request:', msg)
    Sentry.captureException(e, {
      tags: { component: 'billing', event: 'checkout_create_failed', userId: String(session.user.id) }
    })
    throw createError({ statusCode: 502, message: `Could not start checkout: ${msg}` })
  }
})
