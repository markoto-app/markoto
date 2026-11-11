import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool, type QueryConfig, type QueryArrayConfig } from 'pg'
import * as Sentry from '@sentry/nuxt'
import * as schema from '../../db/schema'
import { postgresUrlFromEnv } from '../../../shared/utils/runtime/connectionStrings'
import { resolvePostgresSsl } from '../../../shared/utils/runtime/postgresSsl'

let db: ReturnType<typeof drizzle<typeof schema>> | null = null
let pool: Pool | null = null

/**
 * Slow-query threshold in ms (`NUXT_DB_SLOW_QUERY_MS`, default 200). Slower
 * queries raise a warning-level Sentry event. Read once at module load, so
 * changing it needs a restart.
 */
const SLOW_QUERY_THRESHOLD_MS = (() => {
  const raw = process.env.NUXT_DB_SLOW_QUERY_MS
  const n = raw ? Number(raw) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : 200
})()

/**
 * Wrap `pool.query` with a timing probe. Slow queries are reported with the
 * SQL truncated to 500 chars and the param COUNT only, never the values,
 * which can carry PII or secrets.
 *
 * Only the Promise branch is timed; a non-Promise return (a Submittable)
 * passes through unwrapped so callers that consume its events still work.
 */
function instrumentPoolForSlowQueries(p: Pool): void {
  const orig = p.query.bind(p)
  // Cast through `unknown`: `pg.Pool.query` has too many overloads to type.
  // The wrapper does not change semantics, so the cast is sound.
  ;(p as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
    const start = performance.now()
    const result = (orig as unknown as (...a: unknown[]) => unknown)(...args)
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      return (result as Promise<unknown>).then((r) => {
        const ms = performance.now() - start
        if (ms > SLOW_QUERY_THRESHOLD_MS) {
          // Drizzle uses the QueryConfig-object overload, raw callers the string one.
          let sql = '<unknown>'
          const first = args[0]
          if (typeof first === 'string') {
            sql = first
          } else if (first && typeof first === 'object') {
            const cfg = first as Partial<QueryConfig | QueryArrayConfig>
            if (typeof cfg.text === 'string') sql = cfg.text
          }
          // Param count: second positional arg, or `config.values`.
          let paramsCount: number | undefined
          const second = args[1]
          if (Array.isArray(second)) {
            paramsCount = second.length
          } else if (first && typeof first === 'object' && Array.isArray((first as { values?: unknown[] }).values)) {
            paramsCount = (first as { values: unknown[] }).values.length
          }
          try {
            Sentry.captureMessage('slow-query', {
              level: 'warning',
              tags: { component: 'db', event: 'slow_query' },
              extra: {
                sql: String(sql).slice(0, 500),
                paramsCount,
                durationMs: Math.round(ms),
                thresholdMs: SLOW_QUERY_THRESHOLD_MS
              }
            })
          } catch {
            // Telemetry must never propagate into the query path.
          }
        }
        return r
      })
    }
    return result
  }
}

export function useDatabase() {
  if (!db) {
    pool = new Pool({
      connectionString: postgresUrlFromEnv(),
      // Prod verifies the server cert (pinned CA or system bundle); dev keeps
      // TLS off for the local TLS-less Postgres. See shared/utils/runtime/postgresSsl.ts.
      ssl: resolvePostgresSsl(),
      // The default of 10 is too tight: many handlers hold a connection across
      // S3 / LiteLLM / markitdown calls. 30 stays well under Postgres
      // `max_connections` even with the sync container sharing the DB.
      max: 30,
      idleTimeoutMillis: 30_000,
      // Hard cap so a runaway query can't hold a pool slot forever.
      statement_timeout: 30_000,
      // Pool exhaustion fails after 5s instead of hanging the request.
      connectionTimeoutMillis: 5_000
    })
    instrumentPoolForSlowQueries(pool)
    db = drizzle(pool, { schema })
  }
  return db
}

// The migration plugin reuses this pool.
export function useDatabasePool(): Pool {
  if (!pool) {
    useDatabase()
  }
  return pool!
}

// Called on Nitro `close` so in-flight queries finish before the container exits.
export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
    db = null
  }
}
