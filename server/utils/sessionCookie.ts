// No session cookie for visitors who never signed in.
//
// h3's `useSession` (behind nuxt-auth-utils' `getUserSession`) CREATES a
// session — and sends `Set-Cookie: nuxt-session=…` — whenever a request
// without one reads it. nuxt-auth-utils reads it on EVERY request (its
// websocket plugin, active because `nitro.experimental.websocket` is on,
// calls `getUserSession` from the `request` hook), and our auth
// middleware reads it on `/api` calls. So every static asset, every page
// and every API answer handed anonymous visitors a fresh, empty, sealed
// session cookie: uncacheable responses, and a cookie the privacy policy
// says is "set only when you sign in".
//
// `dropUnusedSessionCookie` (run by `plugins/session-cookie.ts` before
// every response, and by the error handler) removes that header again
// when the request carried no session cookie AND the session still holds
// no data. Sign-in (`setUserSession` writes data) and sign-out / stale
// cookie clean-up (the request carried a cookie) are untouched, and a
// signed-in browser's cookie is never re-set by a read, exactly as
// before (h3 only re-seals on update).

import type { H3Event } from 'h3'

/** nuxt-auth-utils' cookie name (`runtimeConfig.session.name` default). */
export const DEFAULT_SESSION_COOKIE = 'nuxt-session'

/** True when a `Cookie` request header carries a cookie of that name. */
export function requestHasCookie(cookieHeader: string | undefined, name: string): boolean {
  if (!cookieHeader) return false
  return cookieHeader.split(';').some(part => part.trim().startsWith(`${name}=`))
}

/** The `Set-Cookie` values without the ones for `name`. */
export function withoutCookie(setCookies: string[], name: string): string[] {
  return setCookies.filter(value => !value.trimStart().startsWith(`${name}=`))
}

/**
 * Whether a response's session cookie is one nobody asked for: the
 * request had none and the session was only read (no data written).
 */
export function isUnusedSession(input: { requestHadCookie: boolean, sessionData: Record<string, unknown> | undefined }): boolean {
  if (input.requestHadCookie) return false
  return Object.keys(input.sessionData ?? {}).length === 0
}

function sessionDataOf(event: H3Event, name: string): Record<string, unknown> | undefined {
  const sessions: unknown = event.context.sessions
  if (typeof sessions !== 'object' || sessions === null) return undefined
  const session: unknown = (sessions as Record<string, unknown>)[name]
  if (typeof session !== 'object' || session === null) return undefined
  const data: unknown = (session as Record<string, unknown>).data
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
}

/** Removes the `Set-Cookie` of a session that was created only by being read. */
export function dropUnusedSessionCookie(event: H3Event, name: string = DEFAULT_SESSION_COOKIE): void {
  const res = event.node?.res
  if (!res || res.headersSent) return
  // The pages host and custom domains serve user-written pages: no cookie
  // of any kind is ever set there (a stale or forged session cookie sent
  // to such a host would otherwise be answered with a fresh one).
  if (event.context?.publicPageHost) {
    res.removeHeader('set-cookie')
    return
  }
  const data = sessionDataOf(event, name)
  if (data === undefined) return
  const cookieHeader = event.node.req.headers.cookie
  if (!isUnusedSession({ requestHadCookie: requestHasCookie(cookieHeader, name), sessionData: data })) return
  const current = res.getHeader('set-cookie')
  if (current === undefined) return
  const list = Array.isArray(current) ? current : [String(current)]
  const kept = withoutCookie(list, name)
  if (kept.length === list.length) return
  if (kept.length) res.setHeader('set-cookie', kept)
  else res.removeHeader('set-cookie')
}
