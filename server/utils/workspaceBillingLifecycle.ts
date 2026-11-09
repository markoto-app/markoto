import { and, asc, eq, ne } from 'drizzle-orm'
import { workspaceMembers, workspaceSubscriptions } from '../db/schema'
import { useDatabase } from './database'
import { appendAuditEvent } from '../repos/audit'
import { getWorkspaceSubscription, listSubscriptionsByBillingAdmin } from '../repos/workspaceSubscriptions'
import { useStripeClient } from './stripeClient'
import { isBillingEnabled } from './billingMode'
import { cancelWorkspaceSubscriptionAtPeriodEnd, cancelWorkspaceSubscriptionNow } from './workspaceStripe'
import { deleteKeyTokens, deleteWorkspaceTeam, listMemberKeyTokens } from './litellm/workspaceTeams'
import { AUDIT_WORKSPACE_BILLING_ADMIN_CHANGED, AUDIT_WORKSPACE_SUBSCRIPTION_CANCELLED } from '../legal/auditActions'

// Lifecycle hooks of Team / Business billing (WP3): what happens to a
// workspace subscription when its workspace or its billing admin goes.

/**
 * The workspace is being deleted: cancel its subscription now (annual:
 * prorated credit) and delete its LiteLLM team. Best-effort, never
 * blocks the deletion. Call BEFORE the workspace row is deleted (the
 * subscription row cascades with it).
 */
export async function endWorkspaceBilling(workspaceId: string, actorUserId: number | null): Promise<void> {
  const row = await getWorkspaceSubscription(workspaceId)
  if (!row) return
  if (row.stripeSubscriptionId && isBillingEnabled()) {
    await cancelWorkspaceSubscriptionNow(useStripeClient(), row)
    await appendAuditEvent({
      actorUserId,
      actorIp: null,
      scope: 'billing',
      scopeId: workspaceId,
      action: AUDIT_WORKSPACE_SUBSCRIPTION_CANCELLED,
      before: { plan: row.plan, seats: row.seats, status: row.status },
      after: null,
      metadata: { reason: 'workspace_deleted' }
    })
  }
  await deleteWorkspaceTeam(workspaceId)
}

/**
 * The user's account is being deleted: every subscription they are the
 * billing admin of passes to the longest-serving OTHER admin of that
 * workspace. No admin left → the subscription stops renewing and ends at
 * the period end. Workspaces that are cascade-deleted with the account
 * are handled by `endWorkspaceBilling` instead. Run after the admin
 * promotion step of the account deletion.
 */
export async function handOverBillingAdmin(userId: number, skipWorkspaceIds: readonly string[] = []): Promise<number> {
  const subs = await listSubscriptionsByBillingAdmin(userId)
  let handedOver = 0
  for (const sub of subs) {
    if (skipWorkspaceIds.includes(sub.workspaceId)) continue
    const next = (await useDatabase()
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(
        eq(workspaceMembers.workspaceId, sub.workspaceId),
        eq(workspaceMembers.role, 'admin'),
        ne(workspaceMembers.userId, userId)
      ))
      .orderBy(asc(workspaceMembers.joinedAt))
      .limit(1))[0]
    await useDatabase().update(workspaceSubscriptions)
      .set({ billingAdminId: next?.userId ?? null, updatedAt: new Date() })
      .where(eq(workspaceSubscriptions.workspaceId, sub.workspaceId))
    if (!next && isBillingEnabled()) {
      const row = await getWorkspaceSubscription(sub.workspaceId)
      if (row) await cancelWorkspaceSubscriptionAtPeriodEnd(useStripeClient(), row)
    }
    await appendAuditEvent({
      actorUserId: null,
      actorIp: null,
      scope: 'billing',
      scopeId: sub.workspaceId,
      action: AUDIT_WORKSPACE_BILLING_ADMIN_CHANGED,
      before: { billingAdminId: userId },
      after: { billingAdminId: next?.userId ?? null },
      metadata: { reason: 'account_deleted', cancelledAtPeriodEnd: !next }
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
    console.warn(`[workspaceBilling] member key deletion failed: ${e instanceof Error ? e.message : e}`)
    return 0
  }
}
