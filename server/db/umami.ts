// Umami's database (`umami`), next to the app's on the same Postgres
// (docs/operations-analytics.md). The app only deletes expired visitor data
// there (Umami itself keeps everything forever); `server/repos/umamiRetention.ts`
// is the only user of this pool.
//
// Credentials: Umami's own role when the deployment runs one
// (NUXT_ANALYTICS_DB_USER / _PASSWORD, wired by compose from
// POSTGRES_UMAMI_*), else the app's POSTGRES_USER / POSTGRES_PASSWORD.

import { Pool } from 'pg'
import { useEnv } from '~~/shared/env/load'
import { resolvePostgresSsl } from '../../shared/utils/runtime/postgresSsl'
import type { RawEnv } from '~~/shared/env/define'

function umamiDbUrl(source?: RawEnv): string {
  const { analytics, database } = useEnv(source)
  const user = analytics.dbUser || database.user || 'ypad'
  const password = analytics.dbUser ? (analytics.dbPassword ?? '') : database.password
  const host = database.host || 'localhost'
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password ?? '')}@${host}:${database.port}/${analytics.dbName}`
}

let pool: Pool | null = null

export function useUmamiPool(): Pool {
  if (!pool) {
    // Same TLS posture as the app's own pool (managed Postgres: verified TLS).
    pool = new Pool({ connectionString: umamiDbUrl(), ssl: resolvePostgresSsl(useEnv().database, process.env.NODE_ENV === 'production'), max: 1, connectionTimeoutMillis: 5000, idleTimeoutMillis: 5000 })
  }
  return pool
}

export async function closeUmamiPool(): Promise<void> {
  if (pool) {
    const p = pool
    pool = null
    await p.end()
  }
}
