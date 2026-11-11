import { customDomainContext, customDomainView } from '../../../utils/customDomains/manage'
import { listCustomDomainsForUser } from '../../../repos/customDomains'
import { CUSTOM_DOMAINS_PER_USER } from '~~/shared/config/customDomains'

// GET /api/user/custom-domains — the caller's domains with their DNS
// instructions and the page each shows. `available`: the plan
// includes custom domains (adding one needs it; existing ones are listed
// regardless, and stop being served without it).
export default defineApiHandler({
  access: allow.user(),
  instance: 'customDomains',
  handler: async ({ event, user }) => {
    const { settings, available } = await customDomainContext(user.id)
    const rows = await listCustomDomainsForUser(user.id)
    return {
      available,
      limit: CUSTOM_DOMAINS_PER_USER,
      target: settings.target,
      domains: rows.map(d => customDomainView(event, d, settings))
    }
  }
})
