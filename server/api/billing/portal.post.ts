import { eq } from 'drizzle-orm'
import * as Sentry from '@sentry/nuxt'
import { users } from '../../db/schema'
import { useDatabase } from '../../utils/platform/database'
import { useStripeClient } from '../../utils/billing/stripeClient'
import { assertBillingEnabled } from '../../utils/billing/billingMode'

// POST /api/billing/portal — creates a Stripe Customer Portal
// session for the current user and returns the URL to redirect to.
//
// The portal is Stripe's hosted page where users can:
//   - update their payment method
//   - download invoices
//   - cancel, pause, or upgrade their subscription
//   - see their billing history
//
// Only users with an existing `stripe_customer_id` (i.e. who have
// checked out at least once) can open the portal. New users should
// go through `/api/billing/checkout` first.

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  // Billing off → 404 `billing/disabled` before any Stripe call.
  assertBillingEnabled()
  const userId = session.user.id

  // Rate limit: mirrors /api/billing/checkout — portal sessions are
  // real Stripe API objects too.
  if (!(await checkRateLimit('billing-portal', String(userId), 10, 60_000))) {
    throw createError({
      statusCode: 429,
      message: 'Too many portal requests. Try again in a minute.',
      data: { code: 'billing/rate-limited', messageKey: 'error.rateLimited' }
    })
  }

  const stripe = useStripeClient()
  if (!stripe) {
    throw createError({ statusCode: 503, message: 'Billing is not configured. Contact support.' })
  }

  const db = useDatabase()
  const rows = await db.select({
    stripeCustomerId: users.stripeCustomerId
  }).from(users).where(eq(users.id, userId)).limit(1)
  const customerId = rows[0]?.stripeCustomerId
  if (!customerId) {
    throw createError({
      statusCode: 409,
      message: 'No billing history yet. Subscribe first to manage your subscription.'
    })
  }

  // Base URL from the Origin (browsers always send it on POST) with
  // Host as fallback — both survive Traefik.
  const originHeader: string | undefined = getRequestHeader(event, 'origin')
  const hostHeader: string | undefined = getRequestHeader(event, 'host')
  const origin = originHeader ?? hostHeader ?? ''
  const base = origin.startsWith('http') ? origin : `https://${origin}`
  const returnUrl = base + '/pricing'

  try {
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl
    })
    return { url: portalSession.url }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Stripe error'
    console.error('[billing/portal] Stripe rejected the request:', msg)
    Sentry.captureException(e, {
      tags: { component: 'billing', event: 'portal_create_failed', userId: String(userId) }
    })
    throw createError({ statusCode: 502, message: `Could not open billing portal: ${msg}` })
  }
})
