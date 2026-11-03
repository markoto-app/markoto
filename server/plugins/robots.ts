import { robotsTagFor } from '../utils/robots'

// X-Robots-Tag on documents + render routes (rules: server/utils/robots.ts).
// A request hook (not routeRules) so it also covers the SPA fallback and
// error responses of those paths.

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('request', (event) => {
    const tag = robotsTagFor(event.path)
    if (tag) setResponseHeader(event, 'X-Robots-Tag', tag)
  })
})
