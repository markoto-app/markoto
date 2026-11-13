// Shared secret the app sends to the markitdown converter. Markitdown
// parses untrusted uploads, so it gets its own secret rather than
// INTERNAL_API_SECRET: a compromised converter must not be able to call
// the sync-server or the app's /api/internal routes.
//
// Read from the typed env (validated at boot; required there).

import { useEnv } from '~~/shared/env/load'

const MARKITDOWN_SECRET_HEADER = 'X-Markitdown-Secret'

/** Auth header for a markitdown request; empty when no secret is configured (markitdown then answers 401). */
export function markitdownAuthHeaders(): Record<string, string> {
  const secret = useEnv().markitdown.apiSecret
  return secret ? { [MARKITDOWN_SECRET_HEADER]: secret } : {}
}
