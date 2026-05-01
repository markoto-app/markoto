import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool, type QueryConfig, type QueryArrayConfig } from 'pg'
import * as Sentry from '@sentry/nuxt'
import * as schema from '../db/schema'
import { postgresUrlFromEnv } from '../../shared/utils/connectionStrings'
import { resolvePostgresSsl } from '../../shared/utils/postgresSsl'

let db: ReturnType<typeof drizzle<typeof schema>> | null = null
let pool: Pool | null = null

/**
 * Slow-query threshold in ms. Queries that take longer than this trigger
 * a warning-level Sentry event so dashboards can spot N+1 patterns +
 * accidental sequential scans in prod before they cascade into request
 * timeouts. Override via `NUXT_DB_SLOW_QUERY_MS`. 200 ms is a generous
 * default for our workload — typical Drizzle reads land at <20 ms; 200
 * is roughly the threshold where a user starts noticing latency.
 *
 * Read once at module load. Changing this requires a process restart;
 * acceptable for a tuning knob.
 */
const SLOW_QUERY_THRESHOLD_MS = (() => {
  const raw = process.env.NUXT_DB_SLOW_QUERY_MS
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : 200
})()

/**
 * Wrap `pool.query` with a timing probe. Slow queries are reported via
 * Sentry with the SQL truncated to 500 chars and the param COUNT only —
 * never the param values, which often carry PII (emails on auth lookup,
 * doc bodies on activity inserts) or secrets (password hashes, JWTs in
 * audit rows). Truncation also keeps a single Sentry payload small.
 *
 * Synchronous returns (rare — pg.Pool.query is overwhelmingly Promise-
 * returning) fall through unwrapped; we only thread timing through the
 * Promise branch so an exotic caller that pulls events off the returned
 * Submittable still works.
 */
function instrumentPoolForSlowQueries(p: Pool): void {
  const orig = p.query.bind(p)
  // Cast through `unknown` because `pg.Pool.query` is a heavily-overloaded
  // signature (text, config, array-mode, callbacks). We don't change
  // semantics — the wrapper just times the Promise branch — so the cast
  // is sound at runtime.
  ;(p as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
    const start = performance.now()
    const result = (orig as unknown as (...a: unknown[]) => unknown)(...args)
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      return (result as Promise<unknown>).then((r) => {
        const ms = performance.now() - start
        if (ms > SLOW_QUERY_THRESHOLD_MS) {
          // Extract the SQL string from whatever overload the caller used.
          // Drizzle goes through the QueryConfig-object form; raw `pool.query('SELECT ...')`
          // hits the string form.
          let sql = '<unknown>'
          const first = args[0]
          if (typeof first === 'string') {
            sql = first
          } else if (first && typeof first === 'object') {
            const cfg = first as Partial<QueryConfig | QueryArrayConfig>
            if (typeof cfg.text === 'string') sql = cfg.text
          }
          // Param count comes from either the second positional arg
          // (when query was called as `query(text, values)`) or from
          // `config.values`.
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
      // TLS-in-transit posture. In prod we verify the server cert
      // (rejectUnauthorized: true) against either a pinned CA from
      // PGSSLROOTCERT or the system bundle. Dev keeps TLS off so the
      // local postgres-in-docker (no TLS) keeps working. See
      // shared/utils/postgresSsl.ts for the full rationale.
      ssl: resolvePostgresSsl(),
      // Default `max` is 10. On a single VPS that's tight: many of our
      // handlers hold a connection across S3 / Gemini / markitdown calls,
      // so the pool can exhaust at ~50–100 RPS even when Postgres itself
      // is idle. 30 covers our expected steady-state without overrunning
      // Postgres `max_connections` (sync container also pulls from the
      // same DB; budget across both stays well under 100).
      max: 30,
      // Close idle connections after 30s to reduce server-side memory
      // pressure during quiet periods.
      idleTimeoutMillis: 30_000,
      // Hard cap so a runaway query can't hold a pool slot forever.
      // 30s is generous for our workload; longer queries should be
      // explicit (none today).
      statement_timeout: 30_000,
      // Surface "pool exhausted" as a 5s error rather than letting the
      // request hang indefinitely. Faster failure = clearer signal in
      // logs + Sentry when load actually exceeds capacity.
      connectionTimeoutMillis: 5_000
    })
    instrumentPoolForSlowQueries(pool)
    db = drizzle(pool, { schema })
  }
  return db
}

// Exposed for the migration plugin so it can reuse the same pool.
export function useDatabasePool(): Pool {
  if (!pool) {
    // Force pool creation via useDatabase().
    useDatabase()
  }
  return pool!
}

// Close the pg pool. Called from the shutdown plugin on Nitro `close` so
// in-flight queries finish cleanly before the container exits.
export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
    db = null
  }
}
