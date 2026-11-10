import { randomBytes } from 'node:crypto'
import { nanoid } from 'nanoid'
import { customDomainView, requireCustomDomainUser, validateNewHostname } from '../../../utils/customDomains/manage'
import { countCustomDomainsForUser, insertCustomDomain, isHostnameUnavailable, listCustomDomainsForUser } from '../../../repos/customDomains'
import { assertPlanFeature, resolveUserPlan } from '../../../utils/entitlements'
import { appendAuditEvent } from '../../../repos/audit'
import { AUDIT_CUSTOM_DOMAIN_ADDED } from '../../../legal/auditActions'
import { CUSTOM_DOMAIN_ERROR_CODES, CUSTOM_DOMAINS_PER_USER } from '~~/shared/config/customDomains'

// POST /api/user/custom-domains — {hostname}. Adds a pending domain with
// its own verification token (WP13). Plan feature `customDomains`.
export default defineEventHandler(async (event) => {
  const { userId, settings } = await requireCustomDomainUser(event)
  assertPlanFeature(await resolveUserPlan(userId), 'customDomains', 'Custom domains are part of the paid plans.')
  if (!(await checkRateLimit('custom-domain-add', String(userId), 20, 3_600_000))) {
    throw createError({ statusCode: 429, message: 'Too many domains added. Try again later.', data: { code: 'custom-domain/rate-limited' } })
  }
  const body = await readBody<{ hostname?: unknown }>(event).catch(() => ({}))
  const hostname = validateNewHostname(event, (body as { hostname?: unknown }).hostname, settings)
  if (await countCustomDomainsForUser(userId) >= CUSTOM_DOMAINS_PER_USER) {
    throw createError({ statusCode: 409, message: `You can add up to ${CUSTOM_DOMAINS_PER_USER} domains.`, data: { code: CUSTOM_DOMAIN_ERROR_CODES.limit, limit: CUSTOM_DOMAINS_PER_USER } })
  }
  const taken = () => createError({ statusCode: 409, message: 'This domain is already in use.', data: { code: CUSTOM_DOMAIN_ERROR_CODES.taken } })
  if (await isHostnameUnavailable(hostname, userId)) throw taken()
  const id = nanoid(16)
  try {
    await insertCustomDomain({ id, hostname, userId, verifyToken: randomBytes(18).toString('base64url') })
  } catch (e) {
    if ((e as { code?: string }).code === '23505' || (e as { cause?: { code?: string } }).cause?.code === '23505') throw taken()
    throw e
  }
  await appendAuditEvent({
    actorUserId: userId,
    actorIp: getClientIp(event),
    scope: 'user',
    scopeId: String(userId),
    action: AUDIT_CUSTOM_DOMAIN_ADDED,
    metadata: { domainId: id, hostname }
  })
  const row = (await listCustomDomainsForUser(userId)).find(d => d.id === id)!
  setResponseStatus(event, 201)
  return customDomainView(event, row, settings)
})
