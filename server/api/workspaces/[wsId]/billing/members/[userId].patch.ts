import { and, eq, ne } from 'drizzle-orm'
import { workspaceMembers } from '../../../../../db/schema'
import { useDatabase } from '../../../../../utils/platform/database'
import { appendAuditEvent } from '../../../../../repos/audit'
import { getPooledWorkspace, requireWorkspaceBillingAdmin } from '../../../../../utils/billing/workspaceBilling'
import { syncMemberKeyLimit } from '../../../../../utils/litellm/workspaceTeams'
import { AUDIT_WORKSPACE_MEMBER_AI_LIMIT_CHANGED } from '../../../../../legal/auditActions'

/** Largest settable member limit, USD per month (typo guard). */
const MAX_MEMBER_LIMIT_USD = 10_000

// PATCH /api/workspaces/:wsId/billing/members/:userId — a member's monthly
// AI limit inside the workspace's pooled budget (WP3). Workspace admins
// only. Body: {limitUsd: number} | {limitUsd: null} (no member limit; the
// team budget still applies) | {default: true} (2 × the per-seat budget).
// Applied to the member's LiteLLM key at once when they have one; stored
// either way (works with billing off too, so admins can prepare it).
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const wsId = requireWsId(event)
  await requireWorkspaceBillingAdmin(session.user.id, wsId)
  const targetUserId = Number(requireRouteParam(event, 'userId'))
  if (!Number.isInteger(targetUserId) || targetUserId <= 0) throw createError({ statusCode: 400, message: 'Invalid userId' })

  const body = await readBody<{ limitUsd?: unknown, default?: unknown }>(event)
  let next: { aiLimitUsd: number | null, aiUnlimited: boolean }
  if (body?.default === true) {
    next = { aiLimitUsd: null, aiUnlimited: false }
  } else if (body?.limitUsd === null) {
    next = { aiLimitUsd: null, aiUnlimited: true }
  } else if (typeof body?.limitUsd === 'number' && Number.isFinite(body.limitUsd) && body.limitUsd >= 0 && body.limitUsd <= MAX_MEMBER_LIMIT_USD) {
    next = { aiLimitUsd: Math.round(body.limitUsd * 100) / 100, aiUnlimited: false }
  } else {
    throw createError({
      statusCode: 400,
      message: `limitUsd must be a number from 0 to ${MAX_MEMBER_LIMIT_USD}, null (no limit), or {default: true}.`,
      data: { code: 'billing/invalid-member-limit' }
    })
  }

  const updated = await useDatabase().update(workspaceMembers)
    .set(next)
    .where(and(eq(workspaceMembers.workspaceId, wsId), eq(workspaceMembers.userId, targetUserId), ne(workspaceMembers.role, 'guest')))
    .returning({ userId: workspaceMembers.userId })
  if (updated.length === 0) throw createError({ statusCode: 404, message: 'Member not found' })

  const pool = await getPooledWorkspace(wsId)
  if (pool) await syncMemberKeyLimit(pool, targetUserId)

  await appendAuditEvent({
    actorUserId: session.user.id,
    actorIp: getClientIp(event),
    scope: 'billing',
    scopeId: wsId,
    action: AUDIT_WORKSPACE_MEMBER_AI_LIMIT_CHANGED,
    before: null,
    after: next,
    metadata: { affectedUserId: targetUserId }
  })
  return { ok: true, ...next }
})
