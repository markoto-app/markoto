// Generic OpenID Connect sign-in, the per-attempt flow cookie.
//
// state + nonce + PKCE verifier travel from the redirect to the callback
// in ONE httpOnly cookie scoped to `/auth/oidc`, HMAC-SHA256-signed with
// the session password. httpOnly already keeps the values away from page
// scripts; the signature additionally stops a sibling-subdomain cookie
// write ("cookie tossing") from planting attacker-chosen values, which
// would otherwise let an attacker complete the victim's callback with
// the attacker's own code (login CSRF). The cookie carries its own
// issue time and is rejected after 10 minutes regardless of the browser
// honouring Max-Age. Single use: the callback deletes it before doing
// anything else.
//
// Pure apart from `node:crypto` (and zod for the payload).

import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { OidcFlowState } from './client'

export const OIDC_FLOW_COOKIE = 'markoto-oidc-flow'
export const OIDC_FLOW_MAX_AGE_SECONDS = 10 * 60

interface Payload extends OidcFlowState {
  iat: number
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', `oidc-flow:${secret}`).update(body).digest('base64url')
}

export function encodeFlowCookie(flow: OidcFlowState, secret: string, nowMs = Date.now()): string {
  const payload: Payload = { ...flow, iat: Math.floor(nowMs / 1000) }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${sign(body, secret)}`
}

const flowSecret = z.string().min(1).max(256)
/** The signed cookie's payload. */
const oidcFlowPayload = z.object({ state: flowSecret, nonce: flowSecret, codeVerifier: flowSecret, iat: z.number() })

/** Returns the flow state, or null when missing, forged, malformed or expired. */
export function decodeFlowCookie(raw: string | undefined, secret: string, nowMs = Date.now()): OidcFlowState | null {
  if (!raw) return null
  const [body, mac, ...rest] = raw.split('.')
  if (!body || !mac || rest.length > 0) return null
  const expected = Buffer.from(sign(body, secret))
  const actual = Buffer.from(mac)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null

  let json: unknown
  try {
    json = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  const parsed = oidcFlowPayload.safeParse(json)
  if (!parsed.success) return null
  const p = parsed.data
  const ageSeconds = Math.floor(nowMs / 1000) - p.iat
  if (ageSeconds < 0 || ageSeconds > OIDC_FLOW_MAX_AGE_SECONDS) return null
  return { state: p.state, nonce: p.nonce, codeVerifier: p.codeVerifier }
}
