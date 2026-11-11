import { eq } from 'drizzle-orm'
import * as Sentry from '@sentry/nuxt'
import { users } from '../../db/schema'
import { useDatabase } from '../../utils/platform/database'
import { useStripeClient } from '../../utils/billing/stripeClient'
import { MINUTE_MS } from '~~/shared/config/units'

// POST /api/billing/portal: creates a Stripe Customer Portal session (payment
// method, invoices, cancel/upgrade) and returns the redirect URL. Needs an
// existing `stripe_customer_id`; new users go through /api/billing/checkout.

export default defineApiHandler({
  access: allow.user(),
  // Billing off → 404 `billing/disabled` before any Stripe call.
  instance: 'billing',
  body: 'none',
  // Mirrors /api/billing/checkout: portal sessions are real Stripe objects.
  rateLimit: { namespace: 'billing-portal', max: 10, windowMs: MINUTE_MS, key: 'user', error: 'billing/rate-limited' },
  handler: async ({ event, user }) => {
    const userId = user.id
    const stripe = useStripeClient()
    if (!stripe) throw apiError('billing/not-configured')

    const db = useDatabase()
    const rows = await db.select({
      stripeCustomerId: users.stripeCustomerId
    }).from(users).where(eq(users.id, userId)).limit(1)
    const customerId = rows[0]?.stripeCustomerId
    if (!customerId) throw apiError('billing/no-billing-history')

    // Origin (always sent on POST) with Host as fallback; both survive Traefik.
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
      throw apiError('billing/portal-failed')
    }
  }
})
