import { customDomainContext } from '../../../../utils/customDomains/manage'
import { invalidateCustomDomainCache } from '../../../../utils/customDomains/routing'
import { deleteCustomDomain } from '../../../../repos/customDomains'
import { appendAuditEvent } from '../../../../repos/audit'
import { AUDIT_CUSTOM_DOMAIN_REMOVED } from '../../../../legal/auditActions'
import { customDomainParams } from '~~/shared/api/account'

// DELETE /api/user/custom-domains/:domainId — stop serving the domain
// Traefik drops its router at its next poll.
export default defineApiHandler({
  access: allow.user(),
  instance: 'customDomains',
  params: customDomainParams,
  handler: async ({ event, user, params, self }) => {
    await customDomainContext(user.id)
    const removed = await deleteCustomDomain(self, params.domainId)
    if (!removed) throw apiError('custom-domain/not-found')
    invalidateCustomDomainCache()
    await appendAuditEvent({
      by: self,
      actorIp: getClientIp(event),
      scope: 'user',
      scopeId: String(user.id),
      action: AUDIT_CUSTOM_DOMAIN_REMOVED,
      metadata: { domainId: removed.id, hostname: removed.hostname }
    })
    return { ok: true }
  }
})
