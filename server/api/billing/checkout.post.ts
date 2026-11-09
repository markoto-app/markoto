import { eq } from 'drizzle-orm'
import { recordPaidTermsAcceptance, requirePaidTermsAccepted } from '../../utils/paidTerms'
import * as Sentry from '@sentry/nuxt'
import { users } from '../../db/schema'
import { useDatabase } from '../../utils/database'
import { useStripeClient } from '../../utils/stripeClient'
import { findLiveSubscription, changeSubscriptionPrice } from '../../utils/stripePlanChange'
import { assertBillingEnabled } from '../../utils/billingMode'
import { stripePriceIdFor } from '../../utils/stripePrices'
import { isBillingInterval, isCurrency } from '~~/shared/config/pricing'

// POST /api/billing/checkout — plan purchase/upgrade endpoint. Two
// outcomes depending on the caller's current Stripe state:
//
//   - No live subscription → creates a Stripe Checkout Session and
//     returns `{ url, sessionId }` for a full-page redirect.
//   - Live subscription (upgrade between paid tiers) → swaps the price
//     on the EXISTING subscription in place (prorated, charged now)
//     and returns `{ updated: true, plan }`. Never creates a second
//     concurrent subscription.
//
// Flow:
//   1. Client clicks "Upgrade to Pro" on /pricing.
//   2. Frontend POSTs { plan: 'pro' } here.
//   3. Handler creates a Stripe Checkout Session, gets back a URL.
//   4. Frontend does `window.location.href = url`.
//   5. User lands on Stripe's hosted Checkout page.
//   6. On completion Stripe redirects back to our `success_url` and
//      the `checkout.session.completed` webhook fires server-side.
//
// We pass `client_reference_id = userId` so the webhook can associate
// the resulting subscription with our user row. We also pass
// `customer_email` so Stripe pre-fills the payment form.

// Personal checkout sells Pro only — monthly or annual, in EUR or CHF
// (the Stripe price catalogue, server/utils/stripePrices.ts). Team /
// Business are workspace subscriptions bought by a workspace admin
// (pricing plan WP3).

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

  // Rate limit: every call creates a real Stripe Checkout Session — a
  // looping client would generate unbounded abandoned sessions and
  // Stripe API load. 10/min is far above any human retry pattern.
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

  // Pull user's email + existing Stripe anchors. If they've subscribed
  // before (e.g. subscribed → cancelled → now upgrading again), reuse
  // the same Customer so Stripe dashboards show one continuous history.
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

  // A Stripe customer keeps one currency for life: once a user has paid in
  // EUR they can't check out in CHF (Stripe would refuse mid-checkout).
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

  // ── In-place plan change ────────────────────────────────────────────
  // A Checkout Session in `mode: 'subscription'` ALWAYS creates a NEW
  // subscription. If this user already has a live one (monthly ↔ annual,
  // or a row the webhook hasn't caught up with), that would leave them with TWO concurrent
  // subscriptions billing the same customer. Probe the recorded
  // subscription and, when it's live, swap its price in place instead —
  // the `customer.subscription.updated` webhook applies the plan +
  // period + LiteLLM budget exactly like a Checkout-born change.
  let liveSub
  try {
    liveSub = await findLiveSubscription(stripe, stripeSubscriptionId)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Stripe error'
    console.error('[billing/checkout] subscription probe failed:', msg)
    Sentry.captureException(e, {
      tags: { component: 'billing', event: 'subscription_probe_failed', userId: String(userId) }
    })
    // Fail CLOSED: proceeding to Checkout while we can't SEE the
    // existing subscription is exactly how double-billing happens.
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
      // `error_if_incomplete` surfaces payment failures here with
      // nothing changed — the user fixes their card in the Portal.
      throw createError({ statusCode: 502, message: `Could not change your plan: ${msg}` })
    }
    // The webhook is the source of truth for users.plan; the client
    // just shows success + refetches billing (which may briefly still
    // read the old plan until the webhook lands — acceptable).
    await recordPaidTermsAcceptance(event, userId, { kind: 'plan', subject: { type: 'user', id: String(userId) }, item: `${plan}_${interval}` })
    return { updated: true, plan }
  }

  // ── Fresh subscription via Checkout ─────────────────────────────────
  // `success_url` / `cancel_url` from runtime config. Supports
  // `{CHECKOUT_SESSION_ID}` — Stripe substitutes the real session id
  // after completion so our post-checkout page can fetch the order
  // state if we want. Don't URL-encode the placeholder; Stripe reads
  // it verbatim. Base URL comes from the Origin (browsers always send
  // it on POST) with Host as fallback — both survive Traefik.
  const originHeader: string | undefined = getRequestHeader(event, 'origin')
  const hostHeader: string | undefined = getRequestHeader(event, 'host')
  const origin = originHeader ?? hostHeader ?? ''
  const base = origin.startsWith('http') ? origin : `https://${origin}`
  const successUrl = base + (config.stripe.successUrl || '/pricing?checkout=success&session={CHECKOUT_SESSION_ID}')
  const cancelUrl = base + (config.stripe.cancelUrl || '/pricing?checkout=cancelled')

  // Stripe Tax — opt-in via NUXT_STRIPE_AUTOMATIC_TAX=1 because
  // `automatic_tax` HARD-ERRORS unless Stripe Tax is activated + an
  // origin address is configured in the dashboard. Enable the flag as
  // part of the live-mode launch checklist, not before. With an
  // existing customer, Stripe additionally requires `customer_update`
  // permissions to save the collected address/name back to the
  // Customer. `tax_id_collection` lets B2B customers enter a VAT id
  // (EU reverse charge).
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
      // The webhook routes by customer; the metadata names the subject
      // explicitly as well (pricing plan WP2).
      metadata: { subject_type: 'user', subject_id: String(userId) },
      subscription_data: { metadata: { subject_type: 'user', subject_id: String(userId) } },
      success_url: successUrl,
      cancel_url: cancelUrl,
      // Pass the customer if we have one; else pass email so Stripe
      // creates a new Customer linked to that address.
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
