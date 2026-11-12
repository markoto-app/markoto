import { appendAuditEvent } from '../../../../../repos/audit'
import { addSsoDomain, listSsoDomains } from '../../../../../repos/sso'
import { DuplicateError } from '../../../../../repos/errors'
import { AUDIT_SSO_DOMAIN_ADDED } from '../../../../../legal/auditActions'
import { domainView } from '../../../../../utils/sso/admin'
import { newDomainVerificationToken, normalizeSsoDomain } from '../../../../../utils/sso/domains'
import { addSsoDomainBody } from '~~/shared/api/sso'

const MAX_DOMAINS = 20

// POST /api/workspaces/:wsId/sso/domains — {domain}: list an email domain
// to verify with a DNS TXT record. Consumer mail domains (gmail.com,
// outlook.com, …) are refused.
export default defineApiHandler({
  access: allow.workspace('admin', { ignoreSso: true, deny: 'sso/admin-required' }),
  body: addSsoDomainBody,
  invalidCode: 'sso/invalid-domain',
  plan: { feature: 'sso', message: 'Single sign-on is part of the Business plan.' },
  handler: async ({ event, wsId, body, workspaceAccess }) => {
    const domain = normalizeSsoDomain(body.domain)
    if (!domain) throw apiError('sso/invalid-domain', { field: 'domain' })
    if ((await listSsoDomains(workspaceAccess)).length >= MAX_DOMAINS) throw apiError('sso/domain-cap', { max: MAX_DOMAINS })
    try {
      const row = await addSsoDomain(workspaceAccess, domain, newDomainVerificationToken())
      await appendAuditEvent({ by: workspaceAccess, actorIp: getClientIp(event), scope: 'workspace', scopeId: wsId, action: AUDIT_SSO_DOMAIN_ADDED, metadata: { domain } })
      return domainView(row)
    } catch (e) {
      if (e instanceof DuplicateError) throw apiError('sso/domain-exists', undefined, { cause: e })
      throw e
    }
  }
})
