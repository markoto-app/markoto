import type { H3Event } from 'h3'
import { nanoid } from 'nanoid'
import { YEAR_SECONDS } from '~~/shared/config/units'

// First-party cookie that anchors the consent decisions of an
// anonymous visitor. Set on first call; returned on every
// subsequent call. The cookie itself is "essential storage" under
// ePrivacy, required to remember the user's consent choice, and
// therefore does not itself require consent (consent-on-consent
// is the standard exception).
//
// 1-year TTL: long enough that a regular visitor's consent
// preference survives most return visits; short enough that a
// shared device's cookies don't accumulate forever. HttpOnly so
// JS can't enumerate, SameSite=Lax for normal navigation, Secure
// in prod (auto-set when the request is HTTPS).

const COOKIE_NAME = 'markoto-anon'

export async function ensureAnonId(event: H3Event): Promise<string> {
  const existing = getCookie(event, COOKIE_NAME)
  if (existing && /^[A-Za-z0-9_-]{16,32}$/.test(existing)) {
    return existing
  }
  const fresh = nanoid(21)
  setCookie(event, COOKIE_NAME, fresh, {
    httpOnly: true,
    sameSite: 'lax',
    secure: getRequestProtocol(event) === 'https',
    path: '/',
    maxAge: YEAR_SECONDS
  })
  return fresh
}
