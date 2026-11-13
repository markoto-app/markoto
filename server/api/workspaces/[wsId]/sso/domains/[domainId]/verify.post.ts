import { appendAuditEvent } from '../../../../../../repos/audit'
import { getSsoDomain, markSsoDomainVerified } from '../../../../../../repos/sso'
import { DuplicateError } from '../../../../../../repos/errors'
import { AUDIT_SSO_DOMAIN_VERIFIED } from '../../../../../../legal/auditActions'
import { domainView } from '../../../../../../utils/sso/admin'
import { domainHasVerificationRecord } from '../../../../../../utils/sso/domains'
import { MINUTE_MS } from '~~/shared/config/units'
import { ssoDomainParams } from '~~/shared/api/sso'

// POST /api/workspaces/:wsId/sso/domains/:domainId/verify: look up the
// TXT record now. 422 sso/domain-unverified when it isn't there
// (yet: DNS can take a while); 409 sso/domain-taken when another
// workspace verified the domain first. 30 DNS checks / admin / 10 min;
// an already verified domain answers without counting.
export default defineApiHandler({
  access: allow.workspace('admin', { ignoreSso: true, deny: 'sso/admin-required' }),
  params: ssoDomainParams,
  body: 'none',
  plan: { feature: 'sso', message: 'Single sign-on is part of the Business plan.' },
  handler: async ({ event, user, wsId, params, workspaceAccess }) => {
    const id = Number(params.domainId)
    const domain = Number.isInteger(id) ? await getSsoDomain(workspaceAccess, id) : null
    if (!domain) throw apiError('sso/domain-not-found')
    if (domain.verifiedAt) return domainView(domain)
    if (!(await checkRateLimit('sso-domain-verify', String(user.id), 30, 10 * MINUTE_MS))) throw apiError('sso/rate-limited')
    if (!(await domainHasVerificationRecord(domain.domain, domain.verificationToken))) throw apiError('sso/domain-unverified')
    try {
      await markSsoDomainVerified(workspaceAccess, id)
    } catch (e) {
      if (e instanceof DuplicateError) throw apiError('sso/domain-taken', undefined, { cause: e })
      throw e
    }
    await appendAuditEvent({ by: workspaceAccess, actorIp: getClientIp(event), scope: 'workspace', scopeId: wsId, action: AUDIT_SSO_DOMAIN_VERIFIED, metadata: { domain: domain.domain } })
    return { ...domainView(domain), verified: true }
  }
})
