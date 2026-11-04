import { robotsTagFor } from '../utils/robots'
import { resolveSiteIndexable } from '../../shared/config/instance'

// X-Robots-Tag on documents + render routes (rules: server/utils/robots.ts),
// and on EVERY response when the instance is not indexable
// (`NUXT_SITE_INDEXABLE=false`, staging). A request hook (not routeRules)
// so it also covers the SPA fallback and error responses of those paths.

export default defineNitroPlugin((nitroApp) => {
  const indexable = resolveSiteIndexable(process.env)
  nitroApp.hooks.hook('request', (event) => {
    const tag = robotsTagFor(event.path, indexable)
    if (tag) setResponseHeader(event, 'X-Robots-Tag', tag)
  })
})
