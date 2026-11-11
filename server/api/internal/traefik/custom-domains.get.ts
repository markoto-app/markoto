import { matchesCurrentOrPrevious } from '../../../../shared/utils/security/internalSecret'
import { traefikProviderSettings } from '../../../utils/customDomains/config'
import { liveCustomDomains } from '../../../utils/customDomains/routing'
import { buildTraefikDynamicConfig } from '../../../utils/customDomains/traefikConfig'
import { publishPagesSettings } from '../../../utils/publish/pagesHost'

// GET /api/internal/traefik/custom-domains — Traefik's HTTP provider polls
// this: one router per live custom domain, plus one for the pages host
// (NUXT_PUBLISH_PAGES_HOST) where the stack asks for it
// (NUXT_PUBLISH_TRAEFIK_PAGES_ROUTER), each with a certificate from the
// instance's ACME resolver. Only reachable inside the stack
// (Traefik → app on the `web` network) and only with the provider token
// (`NUXT_PUBLISH_TRAEFIK_TOKEN`, sent by Traefik as a header). The public
// routers exclude /api/internal/ and server/middleware/auth.ts refuses
// requests that carry the edge proxy's forwarding headers. Without a
// configured token it answers an empty configuration: the compose files
// always enable the provider, and an error would make Traefik log and
// back off forever on instances that don't use custom domains.
export default defineEventHandler(async (event) => {
  const settings = traefikProviderSettings()
  setHeader(event, 'cache-control', 'no-store')
  if (!settings) return {}
  if (!matchesCurrentOrPrevious(getHeader(event, 'x-markoto-provider-token') ?? '', settings.token)) {
    throw createError({ statusCode: 403, message: 'Forbidden' })
  }
  return buildTraefikDynamicConfig([...(await liveCustomDomains()).values()], settings, settings.pagesRouter ? publishPagesSettings()?.hostname ?? null : null)
})
