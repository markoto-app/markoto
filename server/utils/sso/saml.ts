// Per-workspace SSO (WP14) — SAML 2.0 service provider, on
// `@node-saml/node-saml` (SP-initiated, HTTP-Redirect AuthnRequest →
// HTTP-POST Response). The admin pastes the IdP's entity id, SSO URL and
// signing certificate: the server never fetches IdP metadata.
//
// What a Response must pass (library + this module):
//   - signed ASSERTION with the pasted certificate (`wantAssertionsSigned`;
//     a signed Response alone isn't enough), sha256;
//   - Issuer = the configured IdP entity id; Audience = our entity id
//     for this connection; Destination / Recipient = our ACS URL;
//     NotBefore / NotOnOrAfter with 30 s skew;
//   - InResponseTo = the AuthnRequest THIS browser started: the cache
//     handed to the library at the ACS only knows the request id from the
//     browser's signed flow cookie, and consumes it atomically (Valkey
//     GETDEL) — a response for another browser's request, an unsolicited
//     (IdP-initiated) one, or a second copy of the same one is refused;
//   - an assertion id is accepted once (`rejectReplayedAssertions`,
//     Valkey SET NX until the assertion expires).

import { randomBytes } from 'node:crypto'
import type { H3Event } from 'h3'
import { SAML, ValidateInResponseTo, generateServiceProviderMetadata, type CacheItem, type CacheProvider, type Profile } from '@node-saml/node-saml'
import { useValkey } from '../valkey'
import type { SsoConnectionRow } from '../../repos/sso'
import { samlAcsUrl, samlSpEntityId } from './http'
import type { SsoAssertion } from './completeLogin'

const KEY_PREFIX = 'sso:saml:'
const REQUEST_TTL_SECONDS = 10 * 60

/** A SAML request id: `_` + 40 hex (the library's own shape, with our entropy). */
export function newSamlRequestId(): string {
  return `_${randomBytes(20).toString('hex')}`
}

function isAssertionKey(key: string): boolean {
  return key.startsWith('["assertion"')
}

/**
 * Valkey-backed cache for the library. `boundRequestId` (set at the ACS)
 * makes every OTHER request id invisible, which ties the response to the
 * browser that started the sign-in.
 */
function samlCacheProvider(boundRequestId?: string): CacheProvider & {
  saveIfAbsentAsync(key: string, value: string, expiresAtMs: number): Promise<boolean>
} {
  const valkey = useValkey()
  const visible = (key: string) => boundRequestId === undefined || isAssertionKey(key) || key === boundRequestId
  return {
    async saveAsync(key: string, value: string): Promise<CacheItem | null> {
      await valkey.set(KEY_PREFIX + key, value, 'EX', REQUEST_TTL_SECONDS)
      return { value, createdAt: Date.now() }
    },
    async getAsync(key: string): Promise<string | null> {
      if (!visible(key)) return null
      return valkey.get(KEY_PREFIX + key)
    },
    async removeAsync(key: string | null): Promise<string | null> {
      if (key === null || !visible(key)) return null
      return valkey.getdel(KEY_PREFIX + key)
    },
    async consumeAsync(key: string): Promise<string | null> {
      if (!visible(key)) return null
      return valkey.getdel(KEY_PREFIX + key)
    },
    async saveIfAbsentAsync(key: string, value: string, expiresAtMs: number): Promise<boolean> {
      const ttl = Math.max(1, Math.ceil(expiresAtMs - Date.now()))
      return (await valkey.set(KEY_PREFIX + key, value, 'PX', ttl, 'NX')) === 'OK'
    }
  }
}

export function samlFor(event: H3Event, connection: SsoConnectionRow, opts: { requestId?: string, boundRequestId?: string } = {}): SAML {
  if (connection.protocol !== 'saml' || !connection.samlIdpEntityId || !connection.samlSsoUrl || !connection.samlIdpCert) {
    throw createError({ statusCode: 409, message: 'This connection is not a complete SAML setup.', data: { code: 'sso/incomplete' } })
  }
  const spEntityId = samlSpEntityId(event, connection.id)
  return new SAML({
    callbackUrl: samlAcsUrl(event, connection.id),
    issuer: spEntityId,
    audience: spEntityId,
    entryPoint: connection.samlSsoUrl,
    idpIssuer: connection.samlIdpEntityId,
    idpCert: connection.samlIdpCert,
    wantAssertionsSigned: true,
    // Many IdPs sign only the assertion; that is what we require.
    wantAuthnResponseSigned: false,
    signatureAlgorithm: 'sha256',
    digestAlgorithm: 'sha256',
    validateInResponseTo: ValidateInResponseTo.always,
    rejectReplayedAssertions: true,
    requestIdExpirationPeriodMs: REQUEST_TTL_SECONDS * 1000,
    acceptedClockSkewMs: 30_000,
    // No NameIDPolicy / AuthnContext: the IdP decides (Entra ID, Okta,
    // Google and Keycloak differ here; a mismatch is a failed sign-in).
    identifierFormat: null,
    disableRequestedAuthnContext: true,
    cacheProvider: samlCacheProvider(opts.boundRequestId),
    ...(opts.requestId ? { generateUniqueId: () => opts.requestId! } : {})
  })
}

/** Our SP metadata for the admin to import at their IdP. */
export function samlServiceProviderMetadata(event: H3Event, connection: SsoConnectionRow): string {
  return generateServiceProviderMetadata({
    issuer: samlSpEntityId(event, connection.id),
    callbackUrl: samlAcsUrl(event, connection.id),
    wantAssertionsSigned: true,
    identifierFormat: null
  })
}

const EMAIL_ATTRIBUTES = [
  'email',
  'mail',
  'urn:oid:0.9.2342.19200300.100.1.3',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'
]
const NAME_ATTRIBUTES = [
  'displayName',
  'name',
  'urn:oid:2.16.840.1.113730.3.1.241',
  'http://schemas.microsoft.com/identity/claims/displayname',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'
]
const GIVEN = ['givenName', 'firstName', 'urn:oid:2.5.4.42', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname']
const SURNAME = ['sn', 'surname', 'lastName', 'urn:oid:2.5.4.4', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname']

function firstString(profile: Profile, keys: string[]): string | null {
  for (const key of keys) {
    const v = profile[key]
    const s = Array.isArray(v) ? v[0] : v
    if (typeof s === 'string' && s.trim()) return s.trim()
  }
  return null
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The validated profile as an `SsoAssertion` (subject = NameID). */
export function assertionFromSamlProfile(profile: Profile): SsoAssertion {
  const subject = typeof profile.nameID === 'string' ? profile.nameID.trim() : ''
  if (!subject || subject.length > 255) throw new Error('SAML assertion has no usable NameID')
  let email = firstString(profile, EMAIL_ATTRIBUTES)
  if (!email && /emailAddress$/.test(profile.nameIDFormat ?? '') && EMAIL_RE.test(subject)) email = subject
  if (email && !EMAIL_RE.test(email)) email = null
  const given = firstString(profile, GIVEN)
  const surname = firstString(profile, SURNAME)
  const name = firstString(profile, NAME_ATTRIBUTES) ?? ([given, surname].filter(Boolean).join(' ') || email || 'Workspace member')
  // SAML has no "verified" flag; the domain check in completeLogin decides.
  return { subject, email, emailVerified: false, name }
}
