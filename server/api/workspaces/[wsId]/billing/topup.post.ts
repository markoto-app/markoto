import { recordPaidTermsAcceptance, requirePaidTermsAccepted } from '../../../../utils/billing/paidTerms'
import { useStripeClient } from '../../../../utils/billing/stripeClient'
import { requestBaseUrl } from '../../../../utils/billing/workspaceStripe'
import { getPooledWorkspace } from '../../../../utils/billing/workspaceBilling'
import { automaticTaxEnabled, createTopupCheckout } from '../../../../utils/billing/topupCheckout'
import { buyWorkspaceTopupBody } from '~~/shared/api/billing'
import { MINUTE_MS } from '~~/shared/config/units'

// POST /api/workspaces/:wsId/billing/topup — buy AI credits for a Team /
// Business workspace. Workspace admins; needs an active
// subscription (409 `billing/no-subscription`). Paid on the workspace's
// own Stripe customer, in its currency. Body {pack}.
export default defineApiHandler({
  access: allow.workspace('admin', { deny: 'billing/admin-required' }),
  instance: 'billing',
  body: buyWorkspaceTopupBody,
  rateLimit: { namespace: 'billing-checkout', max: 10, windowMs: MINUTE_MS, key: 'user', error: 'billing/rate-limited' },
  handler: async ({ event, user, wsId, body }) => {
    const pool = await getPooledWorkspace(wsId)
    if (!pool || !pool.subscription.stripeCustomerId) throw apiError('billing/no-subscription')
    requirePaidTermsAccepted(body)
    const stripe = useStripeClient()
    if (!stripe) throw apiError('billing/not-configured')
    const base = requestBaseUrl(event)
    const checkout = await createTopupCheckout(stripe, {
      subject: { type: 'workspace', id: wsId },
      pack: body.pack,
      currency: pool.subscription.currency,
      customer: pool.subscription.stripeCustomerId,
      email: null,
      clientReferenceId: `workspace:${wsId}`,
      successUrl: `${base}/w/${encodeURIComponent(wsId)}?tab=billing&credits=success`,
      cancelUrl: `${base}/w/${encodeURIComponent(wsId)}?tab=billing&credits=cancelled`,
      automaticTax: automaticTaxEnabled(useRuntimeConfig(event).stripe.automaticTax)
    })
    await recordPaidTermsAcceptance(event, user.id, { kind: 'topup', subject: { type: 'workspace', id: wsId }, item: body.pack })
    return checkout
  }
})
