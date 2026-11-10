import { timingSafeEqual } from 'node:crypto'
import { traefikProviderSettings } from '../../../utils/customDomains/config'
import { liveCustomDomains } from '../../../utils/customDomains/routing'
import { buildTraefikDynamicConfig } from '../../../utils/customDomains/traefikConfig'

// GET /api/internal/traefik/custom-domains — Traefik's HTTP provider polls
// this (WP13): one router per live custom domain, each with a certificate
// from the instance's ACME resolver. Only reachable inside the stack
// (Traefik → app on the `web` network) and only with the provider token
// (`NUXT_PUBLISH_TRAEFIK_TOKEN`, sent by Traefik as a header). Without a
// configured token it answers an empty configuration: the compose files
// always enable the provider, and an error would make Traefik log and
// back off forever on instances that don't use custom domains.
export default defineEventHandler(async (event) => {
  const settings = traefikProviderSettings()
  setHeader(event, 'cache-control', 'no-store')
  if (!settings) return {}
  const given = Buffer.from(getHeader(event, 'x-markoto-provider-token') ?? '')
  const want = Buffer.from(settings.token)
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    throw createError({ statusCode: 403, message: 'Forbidden' })
  }
  return buildTraefikDynamicConfig([...(await liveCustomDomains()).values()], settings)
})
