import { getOwnSubscriptionFacts, getUserCheckoutBilling, recordOwnPlanResumed } from '../../repos/userBilling'
import { appendAuditEvent } from '../../repos/audit'
import { useStripeClient } from '../../utils/billing/stripeClient'
import { resumeRecordedSubscription } from '../../utils/billing/resumeSubscription'
import { AUDIT_BILLING_PLAN_RESUMED } from '../../legal/auditActions'
import { MINUTE_MS } from '~~/shared/config/units'
import { useLogger } from '../../utils/platform/logger'

const log = useLogger('billing')

// POST /api/billing/resume: take back the cancellation of the caller's
// Pro plan while it still runs (cancelled in the Stripe portal, ends at
// `cancelAt`). It renews again; nothing is charged now. 409
// `billing/no-subscription` once the plan has ended.
export default defineApiHandler({
  access: allow.user(),
  // Billing off → 404 `billing/disabled` before any Stripe call.
  instance: 'billing',
  body: 'none',
  rateLimit: { namespace: 'billing-resume', max: 10, windowMs: MINUTE_MS, key: 'user', error: 'billing/rate-limited' },
  handler: async ({ event, self }) => {
    const stripe = useStripeClient()
    if (!stripe) throw apiError('billing/not-configured')
    const subscriptionId = (await getUserCheckoutBilling(self))?.stripeSubscriptionId ?? null
    const before = await getOwnSubscriptionFacts(self)
    const { resumed, changedAt } = await resumeRecordedSubscription(stripe, subscriptionId, { userId: String(self.userId) })
    if (!resumed || !subscriptionId) return { resumed: false }

    // Best-effort: the webhook writes the same state.
    try {
      await recordOwnPlanResumed(self, subscriptionId, changedAt)
    } catch (e) {
      log.warn('resumed plan not written locally, the webhook will', { userId: self.userId, err: e })
    }
    await appendAuditEvent({
      by: self,
      actorIp: getClientIp(event),
      scope: 'user',
      scopeId: String(self.userId),
      action: AUDIT_BILLING_PLAN_RESUMED,
      before: { cancelAt: before?.planCancelAt?.toISOString() ?? null },
      metadata: { plan: 'pro' }
    })
    return { resumed: true }
  }
})
