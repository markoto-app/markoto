// Generic OpenID Connect sign-in, validated claims → markoto user profile.
//
// Pure. The input claims have ALREADY been validated by openid-client
// (signature via JWKS, iss, aud, azp, exp/iat, nonce, see `client.ts`);
// this module only decides which claim values markoto stores.
//
// Linking rule (security-relevant):
//   - The identity key is (issuer, sub). Never the email.
//   - The email is only used, stored on the user row, offered for the
//     verified-email account merge, matched against NUXT_ADMIN_USER_EMAILS,
//     found by workspace invites, when the IdP asserts
//     `email_verified === true` (the JSON boolean; the string "true" does
//     not count). An unverified email is dropped entirely, because a
//     stored unverified address would later let a GitHub/Google login
//     with that address merge INTO the IdP-created account (pre-account
//     takeover), and would satisfy the admin allowlist.

export interface OidcProfile {
  issuer: string
  subject: string
  /** Verified email, or null. */
  email: string | null
  emailVerified: boolean
  name: string
}

type Claims = Record<string, unknown>

const MAX_SUBJECT_LENGTH = 255
const MAX_NAME_LENGTH = 255
const MAX_EMAIL_LENGTH = 320

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function pickEmail(source: Claims): { email: string | null, emailVerified: boolean } {
  const email = str(source.email)
  const emailVerified = source.email_verified === true
  if (!email || !emailVerified) return { email: null, emailVerified: false }
  if (email.length > MAX_EMAIL_LENGTH || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    return { email: null, emailVerified: false }
  }
  return { email, emailVerified: true }
}

function pickName(claims: Claims, email: string | null): string {
  const given = str(claims.given_name)
  const family = str(claims.family_name)
  const candidates = [
    str(claims.name),
    given || family ? [given, family].filter(Boolean).join(' ') : null,
    str(claims.preferred_username),
    str(claims.nickname),
    email ? email.split('@')[0] ?? null : null
  ]
  const first = candidates.find((c): c is string => typeof c === 'string' && c.length > 0)
  return (first ?? 'User').slice(0, MAX_NAME_LENGTH)
}

export class OidcProfileError extends Error {}

/**
 * @param idTokenClaims validated ID token claims (must carry `iss` + `sub`)
 * @param userinfo optional UserInfo response, already checked to belong to
 *   the same `sub` (openid-client `fetchUserInfo(..., expectedSubject)`)
 */
export function profileFromClaims(idTokenClaims: Claims, userinfo?: Claims | null): OidcProfile {
  const issuer = str(idTokenClaims.iss)
  const subject = str(idTokenClaims.sub)
  if (!issuer) throw new OidcProfileError('ID token has no issuer')
  if (!subject || subject.length > MAX_SUBJECT_LENGTH) throw new OidcProfileError('ID token has no usable subject')
  if (userinfo && userinfo.sub !== undefined && userinfo.sub !== idTokenClaims.sub) {
    throw new OidcProfileError('UserInfo subject does not match the ID token')
  }

  // Profile claims: UserInfo wins over the ID token (some IdPs, e.g.
  // Authelia, only put profile claims in UserInfo). The email and its
  // verification flag always come from the SAME source, never mixed.
  const merged: Claims = { ...idTokenClaims, ...userinfo }
  const emailSource: Claims = userinfo && userinfo.email !== undefined ? userinfo : idTokenClaims
  const { email, emailVerified } = pickEmail(emailSource)

  return {
    issuer,
    subject,
    email,
    emailVerified,
    name: pickName(merged, email)
  }
}
