import { eq } from 'drizzle-orm'
import { users } from '../../db/schema'
import { useDatabase } from '../../utils/database'
import { useStripeClient } from '../../utils/stripeClient'
import type { PlanName } from '~~/shared/config/tiers'

// POST /api/billing/checkout — creates a Stripe Checkout Session for
// the requested paid plan and returns the URL for the client to
// redirect to.
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

const PLAN_TO_PRICE_KEY: Record<Exclude<PlanName, 'free'>, 'pricePro' | 'priceMax' | 'priceUltra'> = {
  pro: 'pricePro',
  max: 'priceMax',
  ultra: 'priceUltra'
}

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id

  const body = await readBody<{ plan?: unknown }>(event)
  const requestedPlan = typeof body?.plan === 'string' ? body.plan : ''
  if (requestedPlan !== 'pro' && requestedPlan !== 'max' && requestedPlan !== 'ultra') {
    throw createError({ statusCode: 400, message: 'Invalid plan. Must be pro/max/ultra.' })
  }
  const plan = requestedPlan as 'pro' | 'max' | 'ultra'

  const stripe = useStripeClient()
  if (!stripe) {
    throw createError({ statusCode: 503, message: 'Billing is not configured. Contact support.' })
  }
  const config = useRuntimeConfig()
  const priceId = config.stripe[PLAN_TO_PRICE_KEY[plan]]
  if (!priceId) {
    throw createError({ statusCode: 503, message: `No price ID configured for ${plan} plan` })
  }

  // Pull user's email + existing stripe_customer_id. If they've
  // subscribed before (e.g. subscribed → cancelled → now upgrading
  // again), reuse the same Customer so Stripe dashboards show one
  // continuous history.
  const db = useDatabase()
  const rows = await db.select({
    email: users.email,
    stripeCustomerId: users.stripeCustomerId
  }).from(users).where(eq(users.id, userId)).limit(1)
  if (rows.length === 0) {
    throw createError({ statusCode: 404, message: 'User not found' })
  }
  const { email, stripeCustomerId } = rows[0]

  // `success_url` / `cancel_url` from runtime config. Supports
  // `{CHECKOUT_SESSION_ID}` — Stripe substitutes the real session id
  // after completion so our post-checkout page can fetch the order
  // state if we want. Don't URL-encode the placeholder; Stripe reads
  // it verbatim.
  const origin = getRequestHeader(event, 'origin')
    ?? getRequestHeader(event, 'host')
    ?? config.public?.siteUrl
    ?? ''
  const base = origin.startsWith('http') ? origin : `https://${origin}`
  const successUrl = base + (config.stripe.successUrl || '/pricing?checkout=success&session={CHECKOUT_SESSION_ID}')
  const cancelUrl = base + (config.stripe.cancelUrl || '/pricing?checkout=cancelled')

  try {
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'subscription',
      client_reference_id: String(userId),
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      // Pass the customer if we have one; else pass email so Stripe
      // creates a new Customer linked to that address.
      ...(stripeCustomerId
        ? { customer: stripeCustomerId }
        : email ? { customer_email: email } : {})
    })
    if (!checkoutSession.url) {
      throw createError({ statusCode: 502, message: 'Stripe did not return a Checkout URL' })
    }
    return { url: checkoutSession.url, sessionId: checkoutSession.id }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Stripe error'
    console.error('[billing/checkout] Stripe rejected the request:', msg)
    throw createError({ statusCode: 502, message: `Could not start checkout: ${msg}` })
  }
})
