// Module augmentation for nuxt-auth-utils. The package ships empty `User` /
// `UserSession` interfaces and expects the consumer to fill them in — this
// file is the canonical place.
//
// Shape must match what `setUserSession(event, { user: {...} })` writes in
// server/routes/auth/{github,google,oidc}.get.ts, because those objects
// are what flow back through `useUserSession().user` on the client and
// `getUserSession(event).user` on the server.

declare module '#auth-utils' {
  interface User {
    id: number
    // GitHub usernames only — google has no equivalent. The github
    // OAuth handler always sets it; the test shim omits it.
    login?: string | null
    name: string
    // Both OAuth providers set these but their APIs may genuinely
    // return null (e.g. user with no public email). The test shim
    // omits them entirely.
    email?: string | null
    avatar?: string | null
    provider: 'github' | 'google' | 'oidc'
  }

  interface UserSession {
    loggedInAt?: number
    // Bumped whenever the session shape changes (new required fields, type
    // changes, etc.). Sessions whose `v` doesn't match SESSION_VERSION are
    // cleared on the next request — see server/utils/validatedSession.ts.
    v?: number
  }

  // No secure (server-only) session data today; keep the augmentation here
  // so adding fields later is a one-liner.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface SecureSessionData {}
}

export {}
