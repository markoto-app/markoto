// Connection string for the LiteLLM proxy's own database (`litellm`), used
// by the spend-log retention sweep and the admin per-axis spend query —
// the two places the app reads/writes `LiteLLM_SpendLogs` directly.
//
// Same Postgres instance as the app DB (POSTGRES_HOST/PORT). Credentials:
// LiteLLM's own role when the deployment runs one (NUXT_LITELLM_DB_USER /
// NUXT_LITELLM_DB_PASSWORD, wired by the compose files from
// POSTGRES_LITELLM_*; the app role then has no CONNECT on the litellm
// database — infra/postgres/db-init.sh), else the app's POSTGRES_USER /
// POSTGRES_PASSWORD. NUXT_LITELLM_DB_URL overrides everything, for a
// deployment where LiteLLM has its own Postgres. The app already holds the
// LiteLLM master key, so it learning LiteLLM's DB role widens nothing; the
// separation protects the app database FROM a compromised proxy.

import { useEnv } from '~~/shared/env/load'
import type { RawEnv } from '~~/shared/env/define'

export function litellmDbUrl(source?: RawEnv): string {
  const { litellm, database } = useEnv(source)
  if (litellm.dbUrl) return litellm.dbUrl
  // The fallbacks only matter outside a validated boot (scripts, tests).
  const user = litellm.dbUser || database.user || 'ypad'
  const password = litellm.dbUser ? (litellm.dbPassword ?? '') : database.password
  const host = database.host || 'localhost'
  const port = database.port
  const db = litellm.dbName
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${db}`
}
