import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from '../db/schema'
import { postgresUrlFromEnv } from '../../shared/utils/connectionStrings'

let db: ReturnType<typeof drizzle<typeof schema>> | null = null
let pool: Pool | null = null

export function useDatabase() {
  if (!db) {
    pool = new Pool({ connectionString: postgresUrlFromEnv() })
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
