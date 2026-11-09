// Per-workspace SSO (WP14) — email domains.
//
// A workspace proves it owns a domain with a DNS TXT record
// `markoto-verification=<token>` on the domain itself. Only addresses in
// a VERIFIED domain may (a) link to an existing markoto account with the
// same email and (b) join the workspace on their first sign-in (JIT).
// Without that proof an IdP admin could assert any address — e.g. a
// CEO's private Gmail — and take over the matching account.

import { randomBytes } from 'node:crypto'
import { resolveTxt } from 'node:dns/promises'

export const DOMAIN_TXT_PREFIX = 'markoto-verification='
const MAX_DOMAIN_LENGTH = 253

/** Public webmail / consumer domains a workspace can never claim. */
const CONSUMER_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'icloud.com',
  'me.com', 'mac.com', 'aol.com', 'gmx.de', 'gmx.ch', 'gmx.net', 'web.de', 'proton.me', 'protonmail.com',
  'bluewin.ch', 'yandex.com', 'mail.com', 'zoho.com', 'hey.com', 'fastmail.com', 't-online.de', 'orange.fr', 'free.fr'
])

/**
 * Lower-case, trimmed, no trailing dot, IDN as punycode. Null when it
 * isn't a plausible registrable host name (needs a dot, labels of
 * letters / digits / hyphens) or is a consumer mail domain.
 */
export function normalizeSsoDomain(raw: string): string | null {
  let domain = raw.trim().toLowerCase().replace(/\.$/, '')
  if (domain.startsWith('@')) domain = domain.slice(1)
  if (!domain || domain.length > MAX_DOMAIN_LENGTH) return null
  try {
    domain = new URL(`https://${domain}`).hostname
  } catch {
    return null
  }
  const labels = domain.split('.')
  if (labels.length < 2) return null
  if (!labels.every(l => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return null
  if (/^\d+$/.test(labels.at(-1) ?? '')) return null // an IP address
  if (CONSUMER_DOMAINS.has(domain)) return null
  return domain
}

/** The domain part of an email address, normalised the same way (consumer domains included). */
export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null
  const at = email.lastIndexOf('@')
  if (at < 1) return null
  const domain = email.slice(at + 1).trim().toLowerCase().replace(/\.$/, '')
  try {
    return new URL(`https://${domain}`).hostname || null
  } catch {
    return null
  }
}

export function newDomainVerificationToken(): string {
  return randomBytes(18).toString('base64url')
}

export type TxtResolver = (domain: string) => Promise<string[][]>

/**
 * Whether the domain carries `markoto-verification=<token>`. DNS errors
 * (NXDOMAIN, no TXT records, timeouts) count as "not verified".
 */
export async function domainHasVerificationRecord(domain: string, token: string, resolve: TxtResolver = resolveTxt): Promise<boolean> {
  let records: string[][]
  try {
    records = await resolve(domain)
  } catch {
    return false
  }
  const expected = `${DOMAIN_TXT_PREFIX}${token}`
  // A TXT record may be split into several strings; join them.
  return records.some(parts => parts.join('').trim() === expected)
}
