import { randomBytes } from 'node:crypto'
import { nanoid } from 'nanoid'
import { customDomainContext, customDomainView, validateNewHostname } from '../../../utils/customDomains/manage'
import { countCustomDomainsForUser, insertCustomDomain, isHostnameUnavailable, listCustomDomainsForUser } from '../../../repos/customDomains'
import { appendAuditEvent } from '../../../repos/audit'
import { AUDIT_CUSTOM_DOMAIN_ADDED } from '../../../legal/auditActions'
import { addCustomDomainBody } from '~~/shared/api/account'
import { CUSTOM_DOMAINS_PER_USER } from '~~/shared/config/customDomains'
import { HOUR_MS } from '~~/shared/config/units'

// POST /api/user/custom-domains — {hostname}. Adds a pending domain with
// its own verification token. Plan feature `customDomains`.
export default defineApiHandler({
  access: allow.user(),
  body: addCustomDomainBody,
  invalidCode: 'custom-domain/invalid',
  plan: { feature: 'customDomains', message: 'Custom domains are part of the paid plans.' },
  rateLimit: { namespace: 'custom-domain-add', max: 20, windowMs: HOUR_MS, key: 'user', error: 'custom-domain/rate-limited' },
  handler: async ({ event, user, body }) => {
    const userId = user.id
    const { settings } = await customDomainContext(userId)
    const hostname = validateNewHostname(event, body.hostname, settings)
    if (await countCustomDomainsForUser(userId) >= CUSTOM_DOMAINS_PER_USER) {
      throw apiError('custom-domain/limit', { limit: CUSTOM_DOMAINS_PER_USER })
    }
    if (await isHostnameUnavailable(hostname, userId)) throw apiError('custom-domain/taken')
    const id = nanoid(16)
    try {
      await insertCustomDomain({ id, hostname, userId, verifyToken: randomBytes(18).toString('base64url') })
    } catch (e) {
      if ((e as { code?: string }).code === '23505' || (e as { cause?: { code?: string } }).cause?.code === '23505') throw apiError('custom-domain/taken')
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
    const row = (await listCustomDomainsForUser(userId)).find(d => d.id === id)
    if (!row) throw apiError('custom-domain/not-found')
    setResponseStatus(event, 201)
    return customDomainView(event, row, settings)
  }
})
