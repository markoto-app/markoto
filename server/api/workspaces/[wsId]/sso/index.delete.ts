import { appendAuditEvent } from '../../../../repos/audit'
import { deleteSsoConnection } from '../../../../repos/sso'
import { AUDIT_SSO_CONNECTION_DELETED } from '../../../../legal/auditActions'

// DELETE /api/workspaces/:wsId/sso — remove the identity provider.
// Ends enforcement at once; identities and grants go with it. Allowed
// without the plan (a lapsed plan must still be able to switch SSO off)
// and while SSO is enforced (`ignoreSso`).
export default defineApiHandler({
  access: allow.workspace('admin', { ignoreSso: true, deny: 'sso/admin-required' }),
  handler: async ({ event, wsId, workspaceAccess }) => {
    const deleted = await deleteSsoConnection(workspaceAccess)
    if (!deleted) throw apiError('sso/not-configured')
    await appendAuditEvent({ by: workspaceAccess, actorIp: getClientIp(event), scope: 'workspace', scopeId: wsId, action: AUDIT_SSO_CONNECTION_DELETED, metadata: {} })
    return { ok: true }
  }
})
