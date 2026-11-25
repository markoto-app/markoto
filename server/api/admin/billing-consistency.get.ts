import { MINUTE_MS } from '~~/shared/config/units'
import { checkBillingConsistency } from '../../utils/billing/billingConsistency'

// Admin page /admin/billing-consistency: Stripe's live subscriptions against
// markoto's rows, computed on request (read-only; the daily
// `billing-consistency-check` job reports the same to Sentry and email).
// Ids only, no names or emails. Each call pages through Stripe, so it is
// rate-limited per admin. With billing off (or no Stripe key) there is
// nothing to compare.

export default defineApiHandler({
  access: allow.admin(),
  rateLimit: { namespace: 'admin-billing-consistency', max: 6, windowMs: MINUTE_MS, key: 'user', error: 'billing/rate-limited' },
  handler: async () => {
    const stripe = isBillingEnabled() ? useStripeClient() : null
    if (!stripe) return { billingEnabled: false as const, report: null }
    return { billingEnabled: true as const, report: await checkBillingConsistency(stripe) }
  }
})
