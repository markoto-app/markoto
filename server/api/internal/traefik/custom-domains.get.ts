import { liveCustomDomains } from '../../../utils/customDomains/routing'
import { buildTraefikDynamicConfig } from '../../../utils/customDomains/traefikConfig'
import { publishPagesSettings } from '../../../utils/publish/pagesHost'

// GET /api/internal/traefik/custom-domains: polled by Traefik's HTTP provider.
// Emits one router per live custom domain, plus one for the pages host
// (NUXT_PUBLISH_PAGES_HOST) where the stack asks for it
// (NUXT_PUBLISH_TRAEFIK_PAGES_ROUTER), each with a certificate from the ACME
// resolver. Reachable only inside the stack (Traefik -> app on the `web`
// network) and only with the provider token (`NUXT_PUBLISH_TRAEFIK_TOKEN`,
// sent as a header). Public routers exclude /api/internal/ and
// server/middleware/auth.ts refuses requests carrying the edge proxy's
// forwarding headers. Without a token it answers an empty configuration: the
// compose files always enable the provider, and an error would make Traefik
// log and back off forever on instances without custom domains.
export default defineApiHandler({
  // The policy checks the provider token (403 on a wrong one) and hands over
  // the settings, or null when the instance runs no custom domains.
  access: allow.internal('traefik-token'),
  handler: async ({ event, traefik: settings }) => {
    setHeader(event, 'cache-control', 'no-store')
    if (!settings) return {}
    return buildTraefikDynamicConfig([...(await liveCustomDomains()).values()], settings, settings.pagesRouter ? publishPagesSettings()?.hostname ?? null : null)
  }
})
