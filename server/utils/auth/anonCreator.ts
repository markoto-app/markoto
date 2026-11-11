import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { H3Event } from 'h3'
import { getCookie, getRequestProtocol, setCookie } from 'h3'
import { YEAR_SECONDS } from '~~/shared/config/units'

// Creator key for anonymous documents.
//
// An anonymous doc has no owner, so "who may delete it" can't be tied to
// an account. Instead the creating browser holds a random 256-bit key in
// an httpOnly cookie; the doc row stores only its SHA-256
// (`documents.anon_creator_key_hash`). Deleting an ownerless doc requires
// presenting the matching key — anyone else with the link can still edit
// an open-edit doc, but not delete it.
//
// One key per browser (reused across every doc it creates), so the
// cookie count doesn't grow with the number of docs. The key identifies
// nobody: it's random, never linked to an account or IP. Strictly
// necessary for a feature the visitor asked for (deleting their own
// doc), so no consent is involved.
//
// Docs with a NULL hash can't be deleted anonymously; the inactive-doc
// sweep removes them.

const ANON_CREATOR_COOKIE = 'markoto-anon-creator'
// Scoped to the doc API: create (POST /api/docs), delete
// (DELETE /api/docs/:id) and the token endpoint (which reports whether
// this browser may delete). Never sent to other routes.
const COOKIE_PATH = '/api/docs'

/** 32 random bytes, base64url → 43 characters. */
const KEY_SHAPE = /^[\w-]{43}$/

/** The key from a cookie value, or null when absent / malformed. */
export function parseAnonCreatorKey(raw: unknown): string | null {
  return typeof raw === 'string' && KEY_SHAPE.test(raw) ? raw : null
}

/** SHA-256 hex of a creator key — the only form stored on the doc row. */
export function hashAnonCreatorKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

/**
 * Does the presented key match the doc's stored hash? Constant-time on
 * the hash comparison. A NULL stored hash (anonymous doc without a key) never
 * matches.
 */
export function anonCreatorKeyMatches(key: string | null, storedHash: string | null): boolean {
  if (key === null || storedHash === null) return false
  const presented = Buffer.from(hashAnonCreatorKey(key), 'hex')
  const stored = Buffer.from(storedHash, 'hex')
  if (presented.length !== stored.length || stored.length === 0) return false
  return timingSafeEqual(presented, stored)
}

/** The creator key this request carries, or null. */
export function readAnonCreatorKey(event: H3Event): string | null {
  return parseAnonCreatorKey(getCookie(event, ANON_CREATOR_COOKIE))
}

/**
 * The browser's creator key, minting one (and setting the cookie) when
 * the request carries none. Called on anonymous doc creation.
 */
export function ensureAnonCreatorKey(event: H3Event): string {
  const existing = readAnonCreatorKey(event)
  if (existing !== null) return existing
  const fresh = randomBytes(32).toString('base64url')
  setCookie(event, ANON_CREATOR_COOKIE, fresh, {
    httpOnly: true,
    sameSite: 'strict',
    secure: getRequestProtocol(event) === 'https',
    path: COOKIE_PATH,
    maxAge: YEAR_SECONDS
  })
  return fresh
}
