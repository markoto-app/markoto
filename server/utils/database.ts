import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from '../db/schema'
import { postgresUrlFromEnv } from '../../shared/utils/connectionStrings'

let db: ReturnType<typeof drizzle<typeof schema>> | null = null
let pool: Pool | null = null

export function useDatabase() {
  if (!db) {
    pool = new Pool({
      connectionString: postgresUrlFromEnv(),
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
