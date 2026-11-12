import { customDomainContext, customDomainView, runCustomDomainCheck } from '../../../../utils/customDomains/manage'
import { getCustomDomainForUser, listCustomDomainsForUser } from '../../../../repos/customDomains'
import { customDomainParams } from '~~/shared/api/account'
import { HOUR_MS } from '~~/shared/config/units'

// POST /api/user/custom-domains/:domainId/verify: check the DNS records
// now (the sweeper also re-checks pending domains every 15 min).
export default defineApiHandler({
  access: allow.user(),
  instance: 'customDomains',
  params: customDomainParams,
  body: 'none',
  rateLimit: { namespace: 'custom-domain-verify', max: 60, windowMs: HOUR_MS, key: 'user', error: 'custom-domain/rate-limited' },
  handler: async ({ event, user, self, params }) => {
    const userId = user.id
    const { settings } = await customDomainContext(userId)
    const domain = await getCustomDomainForUser(self, params.domainId)
    if (!domain) throw apiError('custom-domain/not-found')
    await runCustomDomainCheck(domain, settings, { self, ip: getClientIp(event) })
    const row = (await listCustomDomainsForUser(self)).find(d => d.id === domain.id)
    if (!row) throw apiError('custom-domain/not-found')
    return customDomainView(event, row, settings)
  }
})
