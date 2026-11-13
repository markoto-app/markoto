import * as Sentry from '@sentry/nuxt'
import { getWorkspaceSubscription } from '../../../../repos/workspaceSubscriptions'
import { useStripeClient } from '../../../../utils/billing/stripeClient'
import { requestBaseUrl } from '../../../../utils/billing/workspaceStripe'
import { MINUTE_MS } from '~~/shared/config/units'

// POST /api/workspaces/:wsId/billing/portal: Stripe Customer Portal for
// the workspace's own customer (invoices, payment method, cancelling).
// Workspace admins only. Plan + seat changes go through our endpoints
// (the portal should be configured without plan switching).
export default defineApiHandler({
  access: allow.workspace('admin', { deny: 'billing/admin-required' }),
  instance: 'billing',
  body: 'none',
  rateLimit: { namespace: 'billing-portal', max: 10, windowMs: MINUTE_MS, key: 'user', error: 'billing/rate-limited' },
  handler: async ({ event, wsId }) => {
    const stripe = useStripeClient()
    if (!stripe) throw apiError('billing/not-configured')

    const row = await getWorkspaceSubscription(wsId)
    if (!row?.stripeCustomerId) throw apiError('billing/no-subscription')
    try {
      const portal = await stripe.billingPortal.sessions.create({
        customer: row.stripeCustomerId,
        return_url: `${requestBaseUrl(event)}/w/${encodeURIComponent(wsId)}?tab=billing`
      })
      return { url: portal.url }
    } catch (e) {
      Sentry.captureException(e, { tags: { component: 'billing', event: 'workspace_portal_failed', workspaceId: wsId } })
      throw apiError('billing/portal-failed')
    }
  }
})
