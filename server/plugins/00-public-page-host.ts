import { publicPageHostKind, sealAgainstCookies } from '../utils/publish/publicHost'

// Requests for the pages host or a custom domain (user-written published
// pages) never get a cookie and never read one — on every path, method
// and status. Route middleware (00.custom-domain.ts) comes too late for
// that: Nitro's static-asset handler answers `/_nuxt/*` (and its 404s)
// before any middleware, and nuxt-auth-utils' own `request` hook has
// already read the session by the time ours runs (a stale cookie gets a
// fresh `Set-Cookie`). So the host is classified here and the response
// itself is sealed (utils/publish/publicHost.ts). Pinned by
// tests/integration/endpoints/publish.test.ts.
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('request', async (event) => {
    const kind = await publicPageHostKind(getRequestHeader(event, 'host'), useRuntimeConfig(event).siteUrl)
    if (!kind) return
    event.context.publicPageHost = kind
    sealAgainstCookies(event)
  })
})
