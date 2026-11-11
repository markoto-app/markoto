import * as Sentry from '@sentry/nuxt'
import { getWorkspaceSubscription } from '../../../../repos/workspaceSubscriptions'
import { assertBillingEnabled } from '../../../../utils/billing/billingMode'
import { useStripeClient } from '../../../../utils/billing/stripeClient'
import { requestBaseUrl } from '../../../../utils/billing/workspaceStripe'
import { requireWorkspaceBillingAdmin } from '../../../../utils/billing/workspaceBilling'

// POST /api/workspaces/:wsId/billing/portal — Stripe Customer Portal for
// the workspace's own customer (invoices, payment method, cancelling).
// Workspace admins only. Plan + seat changes go through our endpoints
// (the portal should be configured without plan switching).
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  assertBillingEnabled()
  const wsId = requireWsId(event)
  await requireWorkspaceBillingAdmin(session.user.id, wsId)

  if (!(await checkRateLimit('billing-portal', String(session.user.id), 10, 60_000))) {
    throw createError({ statusCode: 429, message: 'Too many portal requests. Try again in a minute.', data: { code: 'billing/rate-limited', messageKey: 'error.rateLimited' } })
  }
  const stripe = useStripeClient()
  if (!stripe) throw createError({ statusCode: 503, message: 'Billing is not configured. Contact support.' })

  const row = await getWorkspaceSubscription(wsId)
  if (!row?.stripeCustomerId) {
    throw createError({ statusCode: 409, message: 'This workspace has no billing history yet.', data: { code: 'billing/no-subscription' } })
  }
  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: row.stripeCustomerId,
      return_url: `${requestBaseUrl(event)}/w/${encodeURIComponent(wsId)}?tab=billing`
    })
    return { url: portal.url }
  } catch (e) {
    Sentry.captureException(e, { tags: { component: 'billing', event: 'workspace_portal_failed', workspaceId: wsId } })
    throw createError({ statusCode: 502, message: `Could not open the billing portal: ${e instanceof Error ? e.message : 'Stripe error'}` })
  }
})
