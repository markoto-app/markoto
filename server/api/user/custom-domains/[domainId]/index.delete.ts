import { requireCustomDomainUser } from '../../../../utils/customDomains/manage'
import { invalidateCustomDomainCache } from '../../../../utils/customDomains/routing'
import { deleteCustomDomain } from '../../../../repos/customDomains'
import { appendAuditEvent } from '../../../../repos/audit'
import { AUDIT_CUSTOM_DOMAIN_REMOVED } from '../../../../legal/auditActions'

// DELETE /api/user/custom-domains/:domainId — stop serving the domain
// (WP13). Traefik drops its router at its next poll.
export default defineEventHandler(async (event) => {
  const { userId } = await requireCustomDomainUser(event)
  const removed = await deleteCustomDomain(getRouterParam(event, 'domainId') ?? '', userId)
  if (!removed) throw createError({ statusCode: 404, message: 'Domain not found' })
  invalidateCustomDomainCache()
  await appendAuditEvent({
    actorUserId: userId,
    actorIp: getClientIp(event),
    scope: 'user',
    scopeId: String(userId),
    action: AUDIT_CUSTOM_DOMAIN_REMOVED,
    metadata: { domainId: removed.id, hostname: removed.hostname }
  })
  return { ok: true }
})
