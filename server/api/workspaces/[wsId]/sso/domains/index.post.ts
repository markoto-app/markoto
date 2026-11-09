import { appendAuditEvent } from '../../../../../repos/audit'
import { addSsoDomain, listSsoDomains } from '../../../../../repos/sso'
import { DuplicateError } from '../../../../../repos/errors'
import { AUDIT_SSO_DOMAIN_ADDED } from '../../../../../legal/auditActions'
import { assertSsoPlan, domainView, requireSsoAdmin } from '../../../../../utils/sso/admin'
import { newDomainVerificationToken, normalizeSsoDomain } from '../../../../../utils/sso/domains'

const MAX_DOMAINS = 20

// POST /api/workspaces/:wsId/sso/domains — {domain}: list an email domain
// to verify with a DNS TXT record (WP14). Consumer mail domains (gmail.com,
// outlook.com, …) are refused.
export default defineEventHandler(async (event) => {
  const { userId, wsId } = await requireSsoAdmin(event)
  await assertSsoPlan(wsId)
  const body = await readBody<{ domain?: unknown }>(event)
  const domain = typeof body?.domain === 'string' ? normalizeSsoDomain(body.domain) : null
  if (!domain) throw createError({ statusCode: 400, message: 'Enter your organisation\'s email domain, e.g. example.com. Public mail domains can\'t be used.', data: { code: 'sso/invalid-domain' } })
  if ((await listSsoDomains(wsId)).length >= MAX_DOMAINS) throw createError({ statusCode: 409, message: `At most ${MAX_DOMAINS} domains per workspace.`, data: { code: 'sso/domain-cap' } })
  try {
    const row = await addSsoDomain(wsId, domain, newDomainVerificationToken())
    await appendAuditEvent({ actorUserId: userId, actorIp: getClientIp(event), scope: 'workspace', scopeId: wsId, action: AUDIT_SSO_DOMAIN_ADDED, metadata: { domain } })
    return domainView(row)
  } catch (e) {
    if (e instanceof DuplicateError) throw createError({ statusCode: 409, message: e.message, data: { code: 'sso/domain-exists' } })
    throw e
  }
})
