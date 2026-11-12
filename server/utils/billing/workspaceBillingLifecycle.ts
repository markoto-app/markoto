import { findLongestServingOtherAdmin } from '../../repos/workspaceMembers'
import type { SystemActor, WorkspaceAccess } from '../../repos/proofs'
import { appendAuditEvent } from '../../repos/audit'
import { getWorkspaceSubscription, listSubscriptionsByBillingAdmin, setWorkspaceBillingAdmin, type WorkspaceSubscriptionRow } from '../../repos/workspaceSubscriptions'
import { useStripeClient } from './stripeClient'
import { isBillingEnabled } from './billingMode'
import { cancelWorkspaceSubscriptionAtPeriodEnd, cancelWorkspaceSubscriptionNow } from './workspaceStripe'
import { deleteKeyTokens, deleteWorkspaceTeam, listMemberKeyTokens } from '../litellm/workspaceTeams'
import { deleteCreditsForSubject } from '../../repos/aiCreditGrants'
import { AUDIT_WORKSPACE_BILLING_ADMIN_CHANGED, AUDIT_WORKSPACE_SUBSCRIPTION_CANCELLED } from '../../legal/auditActions'
import { apiError } from '../api/apiError'
import { useLogger } from '../platform/logger'

const log = useLogger('workspace-billing')

// Lifecycle hooks of Team / Business billing: what happens to a
// workspace subscription when its workspace or its billing admin goes.

/**
 * The workspace is being deleted: cancel its subscription now (annual:
 * prorated credit), then drop its top-up credits and its LiteLLM team.
 * Call FIRST, before any of the workspace's documents or its row are
 * deleted: when the subscription can't be cancelled this throws and the
 * deletion must stop (the subscription row cascades with the workspace,
 * and a subscription left running would bill a workspace that is gone).
 * Billing switched off with a subscription still running: refused too
 * (409 `billing/subscription-active`) — no Stripe calls are made then.
 */
/** `ws`: the deleting admin's proof, or the account-deletion job's. */
export async function endWorkspaceBilling(ws: WorkspaceAccess<'admin'>): Promise<void> {
  const workspaceId = ws.workspaceId
  const row = await getWorkspaceSubscription(workspaceId)
  if (row && hasRunningSubscription(row)) {
    const stripe = isBillingEnabled() ? useStripeClient() : null
    if (!stripe) {
      throw apiError('billing/subscription-active')
    }
    await cancelWorkspaceSubscriptionNow(stripe, row)
    await appendAuditEvent({
      by: ws,
      actorIp: null,
      scope: 'billing',
      scopeId: workspaceId,
      action: AUDIT_WORKSPACE_SUBSCRIPTION_CANCELLED,
      before: { plan: row.plan, seats: row.seats, status: row.status },
      after: null,
      metadata: { reason: 'workspace_deleted' }
    })
  }
  // Top-up credits belong to the workspace and go with it.
  await deleteCreditsForSubject({ type: 'workspace', id: workspaceId })
  await deleteWorkspaceTeam(workspaceId)
}

/**
 * Stripe may still bill this subscription: it has an id and hasn't
 * ended. `incomplete` counts — its first payment can still go through.
 */
function hasRunningSubscription(row: Pick<WorkspaceSubscriptionRow, 'stripeSubscriptionId' | 'status'>): boolean {
  return row.stripeSubscriptionId !== null && row.status !== 'canceled' && row.status !== 'incomplete_expired'
}

/**
 * The user's account is being deleted: every subscription they are the
 * billing admin of passes to the longest-serving OTHER admin of that
 * workspace. No admin left → the subscription stops renewing and ends at
 * the period end. Workspaces that are cascade-deleted with the account
 * are handled by `endWorkspaceBilling` instead. Run after the admin
 * promotion step of the account deletion.
 */
export async function handOverBillingAdmin(by: SystemActor, userId: number, skipWorkspaceIds: readonly string[] = []): Promise<number> {
  const subs = await listSubscriptionsByBillingAdmin(userId)
  let handedOver = 0
  for (const sub of subs) {
    if (skipWorkspaceIds.includes(sub.workspaceId)) continue
    const ws = by.workspace(sub.workspaceId)
    const nextId = await findLongestServingOtherAdmin(ws, userId)
    await setWorkspaceBillingAdmin(ws, nextId)
    if (nextId === null && isBillingEnabled()) {
      const row = await getWorkspaceSubscription(sub.workspaceId)
      if (row) await cancelWorkspaceSubscriptionAtPeriodEnd(useStripeClient(), row)
    }
    await appendAuditEvent({
      by,
      actorIp: null,
      scope: 'billing',
      scopeId: sub.workspaceId,
      action: AUDIT_WORKSPACE_BILLING_ADMIN_CHANGED,
      before: { billingAdminId: userId },
      after: { billingAdminId: nextId },
      metadata: { reason: 'account_deleted', cancelledAtPeriodEnd: nextId === null }
    })
    handedOver += 1
  }
  return handedOver
}

/** Delete every workspace key the user holds (account deletion). Best-effort. */
export async function deleteAllMemberKeys(userId: number): Promise<number> {
  try {
    const tokens = await listMemberKeyTokens(userId)
    await deleteKeyTokens(tokens)
    return tokens.length
  } catch (e) {
    log.warn('member key deletion failed', { err: e })
    return 0
  }
}
