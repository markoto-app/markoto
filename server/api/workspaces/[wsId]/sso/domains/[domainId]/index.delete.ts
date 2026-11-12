import { appendAuditEvent } from '../../../../../../repos/audit'
import { deleteSsoDomain, getSsoDomain } from '../../../../../../repos/sso'
import { AUDIT_SSO_DOMAIN_REMOVED } from '../../../../../../legal/auditActions'
import { ssoDomainParams } from '~~/shared/api/sso'

// DELETE /api/workspaces/:wsId/sso/domains/:domainId. Existing
// links and members stay; new sign-ins with that domain no longer link
// or join automatically. Without the plan too (removing only narrows).
export default defineApiHandler({
  access: allow.workspace('admin', { ignoreSso: true, deny: 'sso/admin-required' }),
  params: ssoDomainParams,
  handler: async ({ event, wsId, params, workspaceAccess }) => {
    const id = Number(params.domainId)
    const domain = Number.isInteger(id) ? await getSsoDomain(workspaceAccess, id) : null
    if (!domain || !(await deleteSsoDomain(workspaceAccess, id))) throw apiError('sso/domain-not-found')
    await appendAuditEvent({ by: workspaceAccess, actorIp: getClientIp(event), scope: 'workspace', scopeId: wsId, action: AUDIT_SSO_DOMAIN_REMOVED, metadata: { domain: domain.domain } })
    return { ok: true }
  }
})
