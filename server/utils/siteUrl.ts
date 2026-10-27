// `NUXT_SITE_URL` — the public origin of this instance.
//
// Links in emails (waitlist confirm / unsubscribe) are built ONLY from
// it, never from the request's Host / X-Forwarded-* headers: those are
// client-influenced, and an attacker who can make the app mail a victim
// a link to an attacker-chosen host can harvest the single-use tokens.
// Production boot therefore requires it (`plugins/01-validate-secrets.ts`);
// without it, the emails that need links are not sent.

/** Boot-time validation errors for `NUXT_SITE_URL`. */
export function siteUrlErrors(value: unknown, isProduction: boolean): string[] {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) {
    return isProduction
      ? ['NUXT_SITE_URL is not set (required in production: email links are built from it)']
      : []
  }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return [`NUXT_SITE_URL is not a valid URL: "${raw}"`]
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return [`NUXT_SITE_URL must use http: or https: (got "${parsed.protocol}")`]
  }
  return []
}

/**
 * Base URL for links in outgoing emails: the configured site origin, or
 * null when `NUXT_SITE_URL` is unset / invalid. Callers must NOT fall
 * back to the request host — skip the email instead.
 */
export function emailLinkBaseUrl(configured: unknown): string | null {
  if (typeof configured !== 'string' || configured.trim() === '') return null
  try {
    const url = new URL(configured.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin
  } catch {
    return null
  }
}
