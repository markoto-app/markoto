// The LiteLLM proxy's own database (`litellm`): the app reads and prunes
// `LiteLLM_SpendLogs` there (credit settlement, spend-log retention, the
// admin per-axis spend drill-down).
//
// Same Postgres instance as the app DB (POSTGRES_HOST/PORT). Credentials:
// LiteLLM's own role when the deployment runs one (NUXT_LITELLM_DB_USER /
// NUXT_LITELLM_DB_PASSWORD, wired by the compose files from
// POSTGRES_LITELLM_*; the app role then has no CONNECT on the litellm
// database: deploy/config/postgres/db-init.sh), else the app's POSTGRES_USER /
// POSTGRES_PASSWORD. NUXT_LITELLM_DB_URL overrides everything, for a
// deployment where LiteLLM has its own Postgres. The app already holds the
// LiteLLM master key, so it learning LiteLLM's DB role widens nothing; the
// separation protects the app database FROM a compromised proxy.

import { Pool, type PoolConfig } from 'pg'
import { resolvePostgresSsl } from '../../shared/utils/runtime/postgresSsl'
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

// The one pool on the LiteLLM database. It is a separate database with its
// own role, so it can't share the app pool; every read and write of
// `LiteLLM_SpendLogs` goes through `server/repos/litellmSpend.ts`, which is
// the only user of this handle. Small and quick to give up: the spend
// queries are occasional (credit settlement, retention, the admin
// drill-down), and a sluggish proxy database should fail them, not hold
// connections.
let spendPool: Pool | null = null

/**
 * Connection settings of the spend-log pool. TLS follows the app pool
 * (`server/db/client.ts`): verified in production (the pinned
 * `PGSSLROOTCERT` CA, else the system bundle), off in dev and tests,
 * `PGSSL=disable` opts out. Same Postgres instance, so the same rules; a
 * separate `NUXT_LITELLM_DB_URL` server needs a certificate that verifies
 * the same way.
 */
export function litellmPoolConfig(source?: RawEnv, production: boolean = process.env.NODE_ENV === 'production'): PoolConfig {
  return {
    connectionString: litellmDbUrl(source),
    ssl: resolvePostgresSsl(useEnv(source).database, production),
    max: 2,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 5000
  }
}

export function useLitellmPool(): Pool {
  if (!spendPool) {
    spendPool = new Pool(litellmPoolConfig())
  }
  return spendPool
}

/** Close the pool (Nitro shutdown; tests reset it between cases). */
export async function closeLitellmPool(): Promise<void> {
  if (spendPool) {
    const p = spendPool
    spendPool = null
    await p.end()
  }
}
