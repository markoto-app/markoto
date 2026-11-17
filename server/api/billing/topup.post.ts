import { recordPaidTermsAcceptance, requirePaidTermsAccepted } from '../../utils/billing/paidTerms'
import { getOwnTopupFacts } from '../../repos/userBilling'
import { useStripeClient } from '../../utils/billing/stripeClient'
import { effectivePlan } from '../../utils/billing/billingMode'
import { requestBaseUrl } from '../../utils/billing/workspaceStripe'
import { createTopupCheckout } from '../../utils/billing/topupCheckout'
import { buyTopupBody } from '~~/shared/api/billing'
import { MINUTE_MS } from '~~/shared/config/units'
import { topupEvidence } from '../../utils/billing/checkoutSession'

// POST /api/billing/topup: buy AI credits for yourself. Body
// {pack: '10'|'25'|'50', currency?}. Pro only: free accounts draw on the shared
// free pool, which credits can't lift (409 `billing/topup-needs-plan`). A
// customer who paid in one currency keeps it (409 `billing/currency-locked`).
// Returns Stripe Checkout `{url, sessionId}`; the webhook records the credit.
export default defineApiHandler({
  access: allow.user(),
  instance: 'billing',
  body: buyTopupBody,
  rateLimit: { namespace: 'billing-checkout', max: 10, windowMs: MINUTE_MS, key: 'user', error: 'billing/rate-limited' },
  handler: async ({ event, user, body, self }) => {
    const userId = user.id
    const row = await getOwnTopupFacts(self)
    if (!row) throw apiError('resource/not-found')
    if (effectivePlan(row.plan, row.planValidUntil) === 'free') throw apiError('billing/topup-needs-plan')
    const currency = body.currency ?? row.billingCurrency ?? 'eur'
    if (row.billingCurrency && row.stripeCustomerId && currency !== row.billingCurrency) {
      throw apiError('billing/currency-locked', { currency: row.billingCurrency })
    }
    requirePaidTermsAccepted(body)
    const stripe = useStripeClient()
    if (!stripe) throw apiError('billing/not-configured')
    const base = requestBaseUrl(event)
    const checkout = await createTopupCheckout(stripe, {
      subject: { type: 'user', id: String(userId) },
      pack: body.pack,
      currency,
      customer: row.stripeCustomerId,
      email: row.email,
      clientReferenceId: String(userId),
      successUrl: `${base}/settings/profile?credits=success`,
      cancelUrl: `${base}/settings/profile?credits=cancelled`,
      evidence: await topupEvidence(event)
    })
    await recordPaidTermsAcceptance(event, self, { kind: 'topup', subject: { type: 'user', id: String(userId) }, item: body.pack })
    return checkout
  }
})
