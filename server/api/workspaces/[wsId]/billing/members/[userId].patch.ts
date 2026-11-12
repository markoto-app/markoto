import { setMemberAiLimit } from '../../../../../repos/workspaceBilling'
import { appendAuditEvent } from '../../../../../repos/audit'
import { getPooledWorkspace } from '../../../../../utils/billing/workspaceBilling'
import { syncMemberKeyLimit } from '../../../../../utils/litellm/workspaceTeams'
import { AUDIT_WORKSPACE_MEMBER_AI_LIMIT_CHANGED } from '../../../../../legal/auditActions'
import { memberUserParams, setMemberLimitBody } from '~~/shared/api/billing'

/** Largest settable member limit, USD per month (typo guard). */
const MAX_MEMBER_LIMIT_USD = 10_000

// PATCH /api/workspaces/:wsId/billing/members/:userId: a member's monthly
// AI limit inside the workspace's pooled budget. Workspace admins
// only. Body: {limitUsd: number} | {limitUsd: null} (no member limit; the
// team budget still applies) | {default: true} (2 × the per-seat budget).
// Applied to the member's LiteLLM key at once when they have one; stored
// either way (works with billing off too, so admins can prepare it).
export default defineApiHandler({
  access: allow.workspace('admin', { deny: 'billing/admin-required' }),
  params: memberUserParams,
  body: setMemberLimitBody,
  handler: async ({ event, wsId, params, body, workspaceAccess }) => {
    const targetUserId = params.userId
    let next: { aiLimitUsd: number | null, aiUnlimited: boolean }
    if (body?.default === true) {
      next = { aiLimitUsd: null, aiUnlimited: false }
    } else if (body?.limitUsd === null) {
      next = { aiLimitUsd: null, aiUnlimited: true }
    } else if (typeof body?.limitUsd === 'number' && Number.isFinite(body.limitUsd) && body.limitUsd >= 0 && body.limitUsd <= MAX_MEMBER_LIMIT_USD) {
      next = { aiLimitUsd: Math.round(body.limitUsd * 100) / 100, aiUnlimited: false }
    } else {
      throw apiError('billing/invalid-member-limit', { max: MAX_MEMBER_LIMIT_USD })
    }

    if (!(await setMemberAiLimit(workspaceAccess, targetUserId, next))) throw apiError('billing/member-not-found')

    const pool = await getPooledWorkspace(wsId)
    if (pool) await syncMemberKeyLimit(pool, targetUserId)

    await appendAuditEvent({
      by: workspaceAccess,
      actorIp: getClientIp(event),
      scope: 'billing',
      scopeId: wsId,
      action: AUDIT_WORKSPACE_MEMBER_AI_LIMIT_CHANGED,
      before: null,
      after: next,
      metadata: { affectedUserId: targetUserId }
    })
    return { ok: true, ...next }
  }
})
