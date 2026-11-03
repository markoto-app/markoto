import { createHmac, timingSafeEqual } from 'node:crypto'

// Remembered terms acceptance for anonymous visitors.
//
// After an anonymous visitor ticks "I accept the Terms … and I'm at least
// 16" once, the server sets this httpOnly cookie so the next anonymous
// document from the same browser doesn't ask again — until the terms
// version changes. Value: `v1.<termsVersion>.<acceptedAtMs>.<hmac>`,
// HMAC-SHA-256 over the first three fields with a key derived from
// NUXT_ALTCHA_HMAC_KEY. It identifies nobody (no id, no IP) and is
// strictly necessary for the service the visitor asked for (recording
// that they accepted the terms), so no consent is involved.
//
// Every document created with it stores the version + the original
// acceptance time (documents.anon_terms_version / anon_terms_accepted_at).

export const ANON_TERMS_COOKIE = 'markoto-anon-terms'
// Read by doc creation, the challenge endpoint and anonymous abuse reports.
export const ANON_TERMS_COOKIE_PATH = '/api'
export const ANON_TERMS_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60

const FORMAT = /^v1\.(\d{1,6})\.(\d{10,16})\.([0-9a-f]{64})$/

export interface AnonTermsAcceptance {
  termsVersion: number
  acceptedAt: Date
}

function mac(secret: string, termsVersion: number, acceptedAtMs: number): string {
  return createHmac('sha256', secret).update(`v1.${termsVersion}.${acceptedAtMs}`).digest('hex')
}

export function signTermsCookie(secret: string, acceptance: AnonTermsAcceptance): string {
  const at = acceptance.acceptedAt.getTime()
  return `v1.${acceptance.termsVersion}.${at}.${mac(secret, acceptance.termsVersion, at)}`
}

/**
 * The acceptance a cookie proves, or null when absent, malformed, forged,
 * from the future, or for another terms version than `currentVersion`.
 */
export function readTermsCookie(
  secret: string,
  raw: unknown,
  currentVersion: number,
  now: number = Date.now()
): AnonTermsAcceptance | null {
  if (typeof raw !== 'string') return null
  const m = FORMAT.exec(raw)
  if (!m) return null
  const termsVersion = Number(m[1])
  const acceptedAtMs = Number(m[2])
  const expected = Buffer.from(mac(secret, termsVersion, acceptedAtMs), 'hex')
  const presented = Buffer.from(m[3] ?? '', 'hex')
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null
  if (termsVersion !== currentVersion) return null
  // Small clock-skew allowance between app instances.
  if (acceptedAtMs > now + 60_000) return null
  return { termsVersion, acceptedAt: new Date(acceptedAtMs) }
}
