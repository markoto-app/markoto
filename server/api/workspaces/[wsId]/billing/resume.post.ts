import { getWorkspaceSubscription, recordWorkspacePlanResumed } from '../../../../repos/workspaceSubscriptions'
import { appendAuditEvent } from '../../../../repos/audit'
import { useStripeClient } from '../../../../utils/billing/stripeClient'
import { resumeRecordedSubscription } from '../../../../utils/billing/resumeSubscription'
import { AUDIT_WORKSPACE_BILLING_PLAN_RESUMED } from '../../../../legal/auditActions'
import { MINUTE_MS } from '~~/shared/config/units'
import { useLogger } from '../../../../utils/platform/logger'

const log = useLogger('billing')

// POST /api/workspaces/:wsId/billing/resume: take back the cancellation
// of the workspace's Team / Business plan while it still runs (cancelled
// in the Stripe portal, ends at `cancelAt`). It renews again; nothing is
// charged now. Only the billing admin (the one who pays); a plan without
// one (its billing admin left) can be resumed by any workspace admin.
// 409 `billing/no-subscription` once the plan has ended.
export default defineApiHandler({
  access: allow.workspace('admin', { deny: 'billing/admin-required' }),
  instance: 'billing',
  body: 'none',
  rateLimit: { namespace: 'billing-resume', max: 10, windowMs: MINUTE_MS, key: 'user', error: 'billing/rate-limited' },
  handler: async ({ event, user, wsId, workspaceAccess }) => {
    const stripe = useStripeClient()
    if (!stripe) throw apiError('billing/not-configured')
    const row = await getWorkspaceSubscription(wsId)
    if (!row?.stripeSubscriptionId) throw apiError('billing/no-subscription')
    if (row.billingAdminId !== null && row.billingAdminId !== user.id) throw apiError('billing/admin-required')

    const subscriptionId = row.stripeSubscriptionId
    const { resumed, changedAt } = await resumeRecordedSubscription(stripe, subscriptionId, { workspaceId: wsId })
    if (!resumed) return { resumed: false }

    // Best-effort: the webhook writes the same state.
    try {
      await recordWorkspacePlanResumed(workspaceAccess, subscriptionId, changedAt)
    } catch (e) {
      log.warn('resumed plan not written locally, the webhook will', { workspaceId: wsId, err: e })
    }
    await appendAuditEvent({
      by: workspaceAccess,
      actorIp: getClientIp(event),
      scope: 'billing',
      scopeId: wsId,
      action: AUDIT_WORKSPACE_BILLING_PLAN_RESUMED,
      before: { cancelAt: row.cancelAt?.toISOString() ?? null },
      metadata: { plan: row.plan, seats: row.seats }
    })
    return { resumed: true }
  }
})
