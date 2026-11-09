import { appendAuditEvent } from '../../../../repos/audit'
import { deleteSsoConnection } from '../../../../repos/sso'
import { AUDIT_SSO_CONNECTION_DELETED } from '../../../../legal/auditActions'
import { requireSsoAdmin } from '../../../../utils/sso/admin'

// DELETE /api/workspaces/:wsId/sso — remove the identity provider (WP14).
// Ends enforcement at once; identities and grants go with it. Allowed
// without the plan (a lapsed plan must still be able to switch SSO off).
export default defineEventHandler(async (event) => {
  const { userId, wsId } = await requireSsoAdmin(event)
  const deleted = await deleteSsoConnection(wsId)
  if (!deleted) throw createError({ statusCode: 404, message: 'No single sign-on is set up for this workspace.' })
  await appendAuditEvent({ actorUserId: userId, actorIp: getClientIp(event), scope: 'workspace', scopeId: wsId, action: AUDIT_SSO_CONNECTION_DELETED, metadata: {} })
  return { ok: true }
})
