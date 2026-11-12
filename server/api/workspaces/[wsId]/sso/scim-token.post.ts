import { appendAuditEvent } from '../../../../repos/audit'
import { getSsoConnectionForWorkspace, setScimTokenHash } from '../../../../repos/sso'
import { AUDIT_SSO_SCIM_TOKEN_ROTATED } from '../../../../legal/auditActions'
import { hashScimToken, newScimToken } from '../../../../utils/sso/scim'
import { ssoBaseUrl } from '../../../../utils/sso/http'

// POST /api/workspaces/:wsId/sso/scim-token — create (or replace) the
// SCIM bearer token for the workspace's IdP. Returned ONCE; only
// its SHA-256 is stored. The previous token stops working at once.
export default defineApiHandler({
  access: allow.workspace('admin', { ignoreSso: true, deny: 'sso/admin-required' }),
  body: 'none',
  plan: { feature: 'sso', message: 'Single sign-on is part of the Business plan.' },
  handler: async ({ event, wsId, workspaceAccess }) => {
    const connection = await getSsoConnectionForWorkspace(wsId)
    if (!connection) throw apiError('sso/scim-needs-connection')
    const token = newScimToken()
    await setScimTokenHash(workspaceAccess, connection.id, hashScimToken(token))
    await appendAuditEvent({ by: workspaceAccess, actorIp: getClientIp(event), scope: 'workspace', scopeId: wsId, action: AUDIT_SSO_SCIM_TOKEN_ROTATED, metadata: { revoked: false } })
    setHeader(event, 'cache-control', 'no-store')
    return { token, baseUrl: `${ssoBaseUrl(event)}/scim/v2` }
  }
})
