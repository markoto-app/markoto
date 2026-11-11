import { appendAuditEvent } from '../../../../../../repos/audit'
import { deleteSsoDomain, getSsoDomain } from '../../../../../../repos/sso'
import { AUDIT_SSO_DOMAIN_REMOVED } from '../../../../../../legal/auditActions'
import { requireSsoAdmin } from '../../../../../../utils/sso/admin'

// DELETE /api/workspaces/:wsId/sso/domains/:domainId. Existing
// links and members stay; new sign-ins with that domain no longer link
// or join automatically.
export default defineEventHandler(async (event) => {
  const { userId, wsId } = await requireSsoAdmin(event)
  const id = Number(getRouterParam(event, 'domainId'))
  const domain = Number.isInteger(id) ? await getSsoDomain(wsId, id) : null
  if (!domain || !(await deleteSsoDomain(wsId, id))) throw createError({ statusCode: 404, message: 'Domain not found.' })
  await appendAuditEvent({ actorUserId: userId, actorIp: getClientIp(event), scope: 'workspace', scopeId: wsId, action: AUDIT_SSO_DOMAIN_REMOVED, metadata: { domain: domain.domain } })
  return { ok: true }
})
