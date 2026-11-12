// LiteLLM admin HTTP layer. Wraps `${NUXT_LITELLM_URL}/<path>` with the
// master-key Authorization header so the `/key/*` admin surface is
// callable from one place. No DB, no encryption, pure HTTP.

import { trimTrailingSlashes } from '../../../shared/utils/trimTrailingSlashes'
import { useEnv } from '~~/shared/env/load'

interface LitellmAdminConfig {
  url: string
  masterKey: string
}

function adminConfig(): LitellmAdminConfig {
  const env = useEnv()
  const url = env.litellm.url
  const masterKey = env.litellm.masterKey
  if (!url || !masterKey) {
    throw new Error('[litellmKeys] NUXT_LITELLM_URL and NUXT_LITELLM_MASTER_KEY must be set')
  }
  return { url: trimTrailingSlashes(url), masterKey }
}

export async function litellmAdminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const cfg = adminConfig()
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${cfg.masterKey}`,
    'Content-Type': 'application/json'
  }
  if (init.headers) Object.assign(headers, init.headers)
  return fetch(`${cfg.url}${path}`, { ...init, headers })
}
