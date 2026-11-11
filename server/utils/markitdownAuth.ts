// Shared secret the app sends to the markitdown converter. Markitdown
// parses untrusted uploads, so it gets its own secret rather than
// INTERNAL_API_SECRET: a compromised converter must not be able to call
// the sync-server or the app's /api/internal routes.
//
// Read from process.env on every call (like NUXT_TRUSTED_PROXY_HOPS in
// clientIp.ts) so the helper works outside a Nitro context in tests.

const MARKITDOWN_SECRET_HEADER = 'X-Markitdown-Secret'

/** Auth header for a markitdown request; empty when no secret is configured (markitdown then answers 401). */
export function markitdownAuthHeaders(): Record<string, string> {
  const secret = process.env.NUXT_MARKITDOWN_API_SECRET?.trim()
  return secret ? { [MARKITDOWN_SECRET_HEADER]: secret } : {}
}
