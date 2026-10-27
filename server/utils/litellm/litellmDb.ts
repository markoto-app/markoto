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

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}

export function litellmDbUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = nonEmpty(env.NUXT_LITELLM_DB_URL)
  if (override) return override
  const user = nonEmpty(env.NUXT_LITELLM_DB_USER) ?? env.POSTGRES_USER ?? 'ypad'
  const password = nonEmpty(env.NUXT_LITELLM_DB_USER)
    ? (env.NUXT_LITELLM_DB_PASSWORD ?? '')
    : (env.POSTGRES_PASSWORD ?? '')
  const host = env.POSTGRES_HOST ?? 'localhost'
  const port = env.POSTGRES_PORT ?? '5432'
  const db = env.NUXT_LITELLM_DB_NAME ?? 'litellm'
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${db}`
}
