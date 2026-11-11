// Custom domains for published web pages. Shared by the domain
// endpoints, the DNS check and the settings page.

/** Domains one user may add. */
export const CUSTOM_DOMAINS_PER_USER = 10

/** The TXT record proving the domain is the user's: `<VERIFY_LABEL>.<hostname>`. */
const CUSTOM_DOMAIN_VERIFY_LABEL = '_markoto-verify'

export function customDomainVerifyName(hostname: string): string {
  return `${CUSTOM_DOMAIN_VERIFY_LABEL}.${hostname}`
}

export function customDomainVerifyValue(token: string): string {
  return `markoto-verify=${token}`
}

/** A verified domain whose DNS stops pointing at us is dropped after this long. */
export const CUSTOM_DOMAIN_GRACE_MS = 72 * 60 * 60 * 1000

export const CUSTOM_DOMAIN_ERROR_CODES = {
  disabled: 'custom-domain/disabled',
  invalid: 'custom-domain/invalid',
  taken: 'custom-domain/taken',
  limit: 'custom-domain/limit',
  notVerified: 'custom-domain/not-verified',
  pageNotPublished: 'custom-domain/page-not-published'
} as const

/** Why a DNS check failed — shown to the user as a sentence (`customDomains.dns.*`). */
// `in-use`: the records are right, but another account's claim of the
// same hostname is already verified.
export type CustomDomainDnsProblem = 'txt-missing' | 'txt-mismatch' | 'not-pointing' | 'lookup-failed' | 'in-use'

/**
 * Normalise a user-typed hostname: lowercase, no scheme / path / trailing
 * dot, IDN to punycode. Null when it isn't a plain multi-label DNS name:
 * ports, credentials, IP literals, single labels, wildcards, and the
 * special-use names (`localhost`, `.local`, `.internal`, `.test`, …) —
 * `allowTestNames` lets `.test` through for the test stacks.
 */
export function normalizeCustomHostname(input: unknown, opts: { allowTestNames?: boolean } = {}): string | null {
  if (typeof input !== 'string') return null
  const raw = input.trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.$/, '')
  if (raw.length === 0 || raw.length > 253 || /[:@*\s[\]]/.test(raw)) return null
  let host: string
  try {
    host = new URL(`http://${raw}`).hostname
  } catch {
    return null
  }
  if (host.length > 253 || !host.includes('.')) return null
  const labels = host.split('.')
  if (labels.some(l => l.length === 0 || l.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(l))) return null
  // IPv4 literal (incl. the short forms URL parsing accepts) or numeric TLD.
  if (/^\d+$/.test(labels.at(-1)!)) return null
  const tld = labels.at(-1)!
  if (['localhost', 'local', 'internal', 'invalid', 'example', 'onion', 'alt'].includes(tld)) return null
  if (host.endsWith('.home.arpa') || tld === 'arpa') return null
  if (tld === 'test' && !opts.allowTestNames) return null
  return host
}
