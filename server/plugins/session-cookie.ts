import { DEFAULT_SESSION_COOKIE, dropUnusedSessionCookie } from '../utils/auth/sessionCookie'

// No `Set-Cookie: nuxt-session` for visitors who never signed in (static
// assets, pages, public API answers). Why and how: utils/sessionCookie.ts.
// Pinned by tests/unit/auth/sessionCookie.test.ts.
export default defineNitroPlugin((nitroApp) => {
  const name = useRuntimeConfig().session?.name || DEFAULT_SESSION_COOKIE
  nitroApp.hooks.hook('beforeResponse', (event) => {
    dropUnusedSessionCookie(event, name)
  })
})
