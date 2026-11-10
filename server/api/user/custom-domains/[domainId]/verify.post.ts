import { customDomainView, requireCustomDomainUser, runCustomDomainCheck } from '../../../../utils/customDomains/manage'
import { getCustomDomainForUser, listCustomDomainsForUser } from '../../../../repos/customDomains'

// POST /api/user/custom-domains/:domainId/verify — check the DNS records
// now (WP13; the sweeper also re-checks pending domains every 15 min).
export default defineEventHandler(async (event) => {
  const { userId, settings } = await requireCustomDomainUser(event)
  const domain = await getCustomDomainForUser(getRouterParam(event, 'domainId') ?? '', userId)
  if (!domain) throw createError({ statusCode: 404, message: 'Domain not found' })
  if (!(await checkRateLimit('custom-domain-verify', String(userId), 60, 3_600_000))) {
    throw createError({ statusCode: 429, message: 'Too many checks. Try again in a few minutes.', data: { code: 'custom-domain/rate-limited' } })
  }
  await runCustomDomainCheck(domain, settings, { userId, ip: getClientIp(event) })
  const row = (await listCustomDomainsForUser(userId)).find(d => d.id === domain.id)!
  return customDomainView(event, row, settings)
})
