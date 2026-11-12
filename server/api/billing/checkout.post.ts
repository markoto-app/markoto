import { startCheckoutBody } from '~~/shared/api/billing'
import { MINUTE_MS } from '~~/shared/config/units'
import { startProCheckout } from '../../utils/billing/proCheckout'

// POST /api/billing/checkout: plan purchase/upgrade (`utils/billing/proCheckout.ts`).
//
// Personal checkout sells Pro only (monthly or annual, EUR or CHF; the Stripe
// price catalogue is server/utils/billing/stripePrices.ts). Team / Business are
// workspace subscriptions bought by a workspace admin.

export default defineApiHandler({
  access: allow.user(),
  // Billing off → 404 `billing/disabled` before any Stripe call.
  instance: 'billing',
  body: startCheckoutBody,
  // Every call creates a real Stripe Checkout Session; 10/min is far above any
  // human retry pattern and stops a looping client flooding Stripe.
  rateLimit: { namespace: 'billing-checkout', max: 10, windowMs: MINUTE_MS, key: 'user', error: 'billing/rate-limited' },
  handler: ({ event, user, body }) => {
    if (body.plan !== 'pro') throw apiError('billing/workspace-plan')
    return startProCheckout(event, { userId: user.id, interval: body.interval, currency: body.currency, terms: body })
  }
})
