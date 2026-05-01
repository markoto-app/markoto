import * as Sentry from '@sentry/nuxt'

// Bind the logged-in user id to Sentry so frontend errors carry a user
// scope. ID-only — no email, name, or avatar. PII reduction: a Sentry
// breach should leak as little user-correlatable info as possible, and
// `id` is enough to join with our DB for triage.
//
// Watches the reactive session ref so it survives login/logout without
// a full reload. `useUserSession` is exposed by `nuxt-auth-utils`.
//
// Client-only: Sentry's server-side init already sets `user` from the
// authenticated event, so we only need this on the browser side.
export default defineNuxtPlugin(() => {
  const { loggedIn, user } = useUserSession()

  watch(
    [loggedIn, () => user.value?.id],
    ([isLoggedIn, userId]) => {
      if (isLoggedIn && userId != null) {
        // String for cross-system compatibility — Sentry's user-id field
        // is typed string. Server tags use `String(userId)` for the same
        // reason.
        Sentry.setUser({ id: String(userId) })
      } else {
        Sentry.setUser(null)
      }
    },
    { immediate: true }
  )
})
