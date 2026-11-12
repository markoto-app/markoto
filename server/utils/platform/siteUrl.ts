// `NUXT_SITE_URL`: the public origin of this instance.
//
// Links in emails (waitlist confirm / unsubscribe) are built ONLY from
// it, never from the request's Host / X-Forwarded-* headers: those are
// client-influenced, and an attacker who can make the app mail a victim
// a link to an attacker-chosen host can harvest the single-use tokens.
// Production boot therefore requires it (shared/env/vars/core.ts);
// without it, the emails that need links are not sent.

/**
 * Base URL for links in outgoing emails: the configured site origin, or
 * null when `NUXT_SITE_URL` is unset / invalid. Callers must NOT fall
 * back to the request host, skip the email instead.
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
