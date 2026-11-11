import { assertBillingEnabled } from '../../../../utils/billing/billingMode'
import { recordPaidTermsAcceptance, requirePaidTermsAccepted } from '../../../../utils/billing/paidTerms'
import { useStripeClient } from '../../../../utils/billing/stripeClient'
import { requestBaseUrl } from '../../../../utils/billing/workspaceStripe'
import { getPooledWorkspace, requireWorkspaceBillingAdmin } from '../../../../utils/billing/workspaceBilling'
import { automaticTaxEnabled, createTopupCheckout } from '../../../../utils/billing/topupCheckout'
import { isTopupPackId } from '~~/shared/config/pricing'

// POST /api/workspaces/:wsId/billing/topup — buy AI credits for a Team /
// Business workspace (WP4). Workspace admins; needs an active
// subscription (409 `billing/no-subscription`). Paid on the workspace's
// own Stripe customer, in its currency. Body {pack}.
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  assertBillingEnabled()
  const wsId = requireWsId(event)
  await requireWorkspaceBillingAdmin(session.user.id, wsId)
  if (!(await checkRateLimit('billing-checkout', String(session.user.id), 10, 60_000))) {
    throw createError({ statusCode: 429, message: 'Too many checkout attempts. Try again in a minute.', data: { code: 'billing/rate-limited', messageKey: 'error.rateLimited' } })
  }
  const body = await readBody<{ pack?: unknown }>(event)
  if (!isTopupPackId(body?.pack)) throw createError({ statusCode: 400, message: 'Invalid pack.' })
  const pool = await getPooledWorkspace(wsId)
  if (!pool || !pool.subscription.stripeCustomerId) {
    throw createError({ statusCode: 409, message: 'AI credits are for workspaces with an active Team or Business plan.', data: { code: 'billing/no-subscription' } })
  }
  requirePaidTermsAccepted(body)
  const stripe = useStripeClient()
  if (!stripe) throw createError({ statusCode: 503, message: 'Billing is not configured. Contact support.' })
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
  await recordPaidTermsAcceptance(event, session.user.id, { kind: 'topup', subject: { type: 'workspace', id: wsId }, item: body.pack })
  return checkout
})
