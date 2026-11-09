// Per-workspace SSO (WP14) — the per-attempt flow cookie.
//
// Same construction as the instance OIDC flow cookie
// (`server/utils/oidc/flowCookie.ts`): one httpOnly cookie scoped to
// `/auth/sso`, HMAC-SHA256-signed with the session password (no cookie
// tossing from a sibling subdomain → no login CSRF with an attacker's
// code / response), 10-minute lifetime checked against the cookie's own
// issue time, single use (the callback deletes it first). It carries the
// connection the attempt belongs to, so a response for connection A can
// never complete a flow started for connection B.

import { createHmac, timingSafeEqual } from 'node:crypto'

export const SSO_FLOW_COOKIE = 'markoto-sso-flow'
export const SSO_FLOW_COOKIE_PATH = '/auth/sso'
export const SSO_FLOW_MAX_AGE_SECONDS = 10 * 60

export interface SsoFlow {
  connectionId: string
  /** `test` = an admin checking a draft connection (activates it on success). */
  purpose: 'login' | 'test'
  /** The admin who started a test; their account is the one linked. */
  testUserId?: number
  /** OIDC */
  state?: string
  nonce?: string
  codeVerifier?: string
  /** SAML: the AuthnRequest ID the response must answer. */
  requestId?: string
  /** Same-site path to land on afterwards (validated on the way in). */
  returnTo?: string
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', `sso-flow:${secret}`).update(body).digest('base64url')
}

export function encodeSsoFlow(flow: SsoFlow, secret: string, nowMs = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...flow, iat: Math.floor(nowMs / 1000) })).toString('base64url')
  return `${body}.${sign(body, secret)}`
}

const str = (v: unknown, max = 512): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

/** The flow, or null when missing, forged, malformed or expired. */
export function decodeSsoFlow(raw: string | undefined, secret: string, nowMs = Date.now()): SsoFlow | null {
  if (!raw) return null
  const [body, mac, ...rest] = raw.split('.')
  if (!body || !mac || rest.length > 0) return null
  const expected = Buffer.from(sign(body, secret))
  const actual = Buffer.from(mac)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
  let p: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    p = parsed as Record<string, unknown>
  } catch {
    return null
  }
  if (typeof p.iat !== 'number') return null
  const age = Math.floor(nowMs / 1000) - p.iat
  if (age < 0 || age > SSO_FLOW_MAX_AGE_SECONDS) return null
  if (!str(p.connectionId, 64) || (p.purpose !== 'login' && p.purpose !== 'test')) return null
  if (p.purpose === 'test' && (typeof p.testUserId !== 'number' || !Number.isInteger(p.testUserId))) return null
  const flow: SsoFlow = { connectionId: p.connectionId, purpose: p.purpose }
  if (p.purpose === 'test') flow.testUserId = p.testUserId as number
  for (const key of ['state', 'nonce', 'codeVerifier', 'requestId', 'returnTo'] as const) {
    const v = p[key]
    if (v !== undefined) {
      if (!str(v)) return null
      flow[key] = v
    }
  }
  if (flow.returnTo !== undefined && !isSafeReturnTo(flow.returnTo)) return null
  return flow
}

/** A same-site path: starts with one `/`, no scheme, no backslash tricks. */
export function isSafeReturnTo(path: string): boolean {
  return /^\/(?![/\\])[^\s\\]*$/.test(path) && path.length <= 512
}
