import { sql } from 'drizzle-orm'
import { useDatabase } from '../db/client'

// The database round-trip of the health probes (`/api/health/deep`).

/** One `SELECT 1` through the app pool; rejects when Postgres can't answer. */
export async function pingDatabase(): Promise<void> {
  await useDatabase().execute(sql`SELECT 1`)
}
