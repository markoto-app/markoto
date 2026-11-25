import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool, type QueryConfig } from 'pg'
import * as Sentry from '@sentry/nuxt'
import * as schema from './schema'
import { postgresUrlFromEnv } from '../../shared/utils/runtime/connectionStrings'
import { resolvePostgresSsl } from '../../shared/utils/runtime/postgresSsl'
import { useEnv } from '~~/shared/env/load'
import { isProduction } from '~~/shared/env/runtime'

let db: ReturnType<typeof drizzle<typeof schema>> | null = null
let pool: Pool | null = null

/**
 * Slow-query threshold in ms (`NUXT_DB_SLOW_QUERY_MS`, default 200). Slower
 * queries raise a warning-level Sentry event. Read once at module load, so
 * changing it needs a restart.
 */

/**
 * The pool as drizzle and the migrations see it: `query` goes through a
 * timing probe. Slow queries are reported with the SQL truncated to 500
 * chars and the param COUNT only, never the values, which can carry PII or
 * secrets.
 *
 * A proxy rather than a patched `pool.query`: `Pool.query` has a dozen
 * overloads, and the probe only needs to see the arguments and the result.
 * Only a Promise result is timed; a Submittable (callback / stream use)
 * passes through untouched so callers that consume its events still work.
 */
function withSlowQueryProbe(p: Pool): Pool {
  // Read when the pool is created, not at import: a module-level read would
  // run before boot validation and report only part of the problems.
  const thresholdMs = useEnv().server.slowQueryMs
  const timedQuery = (...args: unknown[]): unknown => {
    const start = performance.now()
    const result: unknown = Reflect.apply(p.query, p, args)
    if (!(result instanceof Promise)) return result
    return result.then((r: unknown) => {
      const ms = performance.now() - start
      if (ms > thresholdMs) reportSlowQuery(args, ms, thresholdMs)
      return r
    })
  }
  return new Proxy(p, {
    get: (target, prop, receiver) => (prop === 'query' ? timedQuery : Reflect.get(target, prop, receiver))
  })
}

function reportSlowQuery(args: unknown[], ms: number, thresholdMs: number): void {
  // Drizzle uses the QueryConfig-object overload, raw callers the string one.
  const first = args[0]
  const config: Partial<QueryConfig> | null = typeof first === 'object' && first !== null ? { ...first } : null
  const sql = typeof first === 'string' ? first : typeof config?.text === 'string' ? config.text : '<unknown>'
  // Param count: second positional arg, or `config.values`.
  const second = args[1]
  const paramsCount = Array.isArray(second) ? second.length : Array.isArray(config?.values) ? config.values.length : undefined
  try {
    Sentry.captureMessage('slow-query', {
      level: 'warning',
      tags: { component: 'db', event: 'slow_query' },
      extra: { sql: sql.slice(0, 500), paramsCount, durationMs: Math.round(ms), thresholdMs }
    })
  } catch {
    // Telemetry must never propagate into the query path.
  }
}

export function useDatabase() {
  if (!db) {
    pool = withSlowQueryProbe(new Pool({
      connectionString: postgresUrlFromEnv(useEnv().database),
      // Prod verifies the server cert (pinned CA or system bundle); dev keeps
      // TLS off for the local TLS-less Postgres. See shared/utils/runtime/postgresSsl.ts.
      ssl: resolvePostgresSsl(useEnv().database, isProduction()),
      // The default of 10 is too tight: many handlers hold a connection across
      // S3 / LiteLLM / markitdown calls. 30 stays well under Postgres
      // `max_connections` even with the sync container sharing the DB.
      max: 30,
      idleTimeoutMillis: 30_000,
      // Hard cap so a runaway query can't hold a pool slot forever.
      statement_timeout: 30_000,
      // Pool exhaustion fails after 5s instead of hanging the request.
      connectionTimeoutMillis: 5_000
    }))
    db = drizzle(pool, { schema })
  }
  return db
}

// The migration plugin reuses this pool.
export function useDatabasePool(): Pool {
  useDatabase()
  if (!pool) throw new Error('database pool not initialised')
  return pool
}

// Called on Nitro `close` so in-flight queries finish before the container exits.
export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
    db = null
  }
}

export type Database = ReturnType<typeof useDatabase>
type DrizzleTx = Parameters<Parameters<Database['transaction']>[0]>[0]

declare const txBrand: unique symbol
/**
 * An open transaction as code outside the repos sees it: opaque, so it can
 * only be handed to repo functions (their optional last parameter), never
 * used to build a query. That keeps every statement in a repo even when one
 * use case writes through several of them atomically.
 */
export interface TxHandle { readonly [txBrand]: true }

/** What a repo function runs its statements on: the shared pool or the caller's transaction. */
export type Executor = Database | DrizzleTx

/**
 * Run `fn` in one transaction: every repo call that receives `tx` commits or
 * rolls back together. The one mechanism for multi-repo atomic writes.
 */
export async function withTransaction<T>(fn: (tx: TxHandle) => Promise<T>): Promise<T> {
  return useDatabase().transaction(async tx => fn(tx as unknown as TxHandle))
}

/** Inside a repo: the caller's transaction when one was passed, else the pool. */
export function executor(tx?: TxHandle | null): Executor {
  return tx ? (tx as unknown as DrizzleTx) : useDatabase()
}

/** Inside a repo that opens its own transaction: hand the drizzle transaction on to other repo functions. */
export function asTxHandle(tx: DrizzleTx): TxHandle {
  return tx as unknown as TxHandle
}
