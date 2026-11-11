import { customDomainView, requireCustomDomainUser } from '../../../utils/customDomains/manage'
import { listCustomDomainsForUser } from '../../../repos/customDomains'
import { CUSTOM_DOMAINS_PER_USER } from '~~/shared/config/customDomains'

// GET /api/user/custom-domains — the caller's domains with their DNS
// instructions and the page each shows. `available`: the plan
// includes custom domains (adding one needs it; existing ones are listed
// regardless, and stop being served without it).
export default defineEventHandler(async (event) => {
  const { userId, settings, available } = await requireCustomDomainUser(event)
  const rows = await listCustomDomainsForUser(userId)
  return {
    available,
    limit: CUSTOM_DOMAINS_PER_USER,
    target: settings.target,
    domains: rows.map(d => customDomainView(event, d, settings))
  }
})
