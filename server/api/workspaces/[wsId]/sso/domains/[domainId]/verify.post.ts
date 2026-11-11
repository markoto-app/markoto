import { appendAuditEvent } from '../../../../../../repos/audit'
import { getSsoDomain, markSsoDomainVerified } from '../../../../../../repos/sso'
import { DuplicateError } from '../../../../../../repos/errors'
import { AUDIT_SSO_DOMAIN_VERIFIED } from '../../../../../../legal/auditActions'
import { assertSsoPlan, domainView, requireSsoAdmin } from '../../../../../../utils/sso/admin'
import { domainHasVerificationRecord } from '../../../../../../utils/sso/domains'
import { MINUTE_MS } from '~~/shared/config/units'

// POST /api/workspaces/:wsId/sso/domains/:domainId/verify — look up the
// TXT record now. 422 sso/domain-unverified when it isn't there
// (yet — DNS can take a while); 409 sso/domain-taken when another
// workspace verified the domain first. 30 checks / admin / 10 min.
export default defineEventHandler(async (event) => {
  const { userId, wsId } = await requireSsoAdmin(event)
  await assertSsoPlan(wsId)
  const id = Number(getRouterParam(event, 'domainId'))
  const domain = Number.isInteger(id) ? await getSsoDomain(wsId, id) : null
  if (!domain) throw createError({ statusCode: 404, message: 'Domain not found.' })
  if (domain.verifiedAt) return domainView(domain)
  if (!(await checkRateLimit('sso-domain-verify', String(userId), 30, 10 * MINUTE_MS))) {
    throw createError({ statusCode: 429, message: 'Too many checks. Try again in a few minutes.', data: { code: 'sso/rate-limited' } })
  }
  if (!(await domainHasVerificationRecord(domain.domain, domain.verificationToken))) {
    throw createError({ statusCode: 422, message: 'The TXT record wasn\'t found yet. DNS changes can take up to an hour.', data: { code: 'sso/domain-unverified' } })
  }
  try {
    await markSsoDomainVerified(wsId, id)
  } catch (e) {
    if (e instanceof DuplicateError) throw createError({ statusCode: 409, message: e.message, data: { code: 'sso/domain-taken' } })
    throw e
  }
  await appendAuditEvent({ actorUserId: userId, actorIp: getClientIp(event), scope: 'workspace', scopeId: wsId, action: AUDIT_SSO_DOMAIN_VERIFIED, metadata: { domain: domain.domain } })
  return { ...domainView(domain), verified: true }
})
