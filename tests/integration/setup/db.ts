import { Pool } from 'pg'
import { TEST_DB_NAME, TEST_DB_URL } from './env'

// Test-side DB access. Separate pool from the Nuxt subprocess — we talk to
// the same database over pg directly for fixture inserts and TRUNCATEs.
// The subprocess has its own pool; they coordinate via row-level writes,
// not connection sharing.

let pool: Pool | null = null

export function testDb(): Pool {
  if (pool) return pool

  // Belt-and-braces guard: the *only* database we're ever allowed to
  // TRUNCATE from tests is the one whose name is `TEST_DB_NAME`. Any
  // other name = someone misconfigured the env, and the tests refuse to
  // run rather than risk wiping dev/prod data.
  if (!TEST_DB_URL.endsWith(`/${TEST_DB_NAME}`)) {
    throw new Error(
      `[test-db] refusing to connect: DB URL does not point at ${TEST_DB_NAME}. Got: ${TEST_DB_URL}`
    )
  }

  pool = new Pool({ connectionString: TEST_DB_URL, max: 5 })
  return pool
}

export async function closeTestDb(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}

/**
 * Truncate every table except drizzle's bookkeeping. Called between tests
 * to isolate state. RESTART IDENTITY resets serial counters so user/doc
 * IDs are predictable across tests.
 *
 * We whitelist the tables explicitly rather than querying information_schema
 * — any table added to the app schema needs to be mirrored here, which is
 * a small but deliberate maintenance tax that flags "did we think about
 * test isolation?" on every new table.
 */
export async function resetDb(): Promise<void> {
  const db = testDb()
  await db.query(`
    TRUNCATE TABLE
      activity_log,
      uploads,
      ai_sessions,
      workspace_members,
      workspaces,
      documents,
      users
    RESTART IDENTITY CASCADE
  `)
  // Drop any Y.js rows the sync-server might have parked. The sync server
  // isn't running during these tests, but notify-deleted handlers still
  // write here in some error paths.
  await db.query('TRUNCATE TABLE IF EXISTS yjs_documents')
    .catch(() => { /* table may not exist on first run */ })
}

/**
 * Block until the DB is reachable. Called by globalSetup before running
 * migrations — useful because docker-compose's healthcheck fires before
 * the first client connection is accepted (a few extra seconds of socket
 * readiness).
 */
export async function waitForDb(timeoutMs = 30_000): Promise<void> {
  const start = Date.now()
  // Fresh pool each retry — if the DB went away mid-wait, a cached pool
  // would hold a broken connection.
  while (Date.now() - start < timeoutMs) {
    const tmp = new Pool({ connectionString: TEST_DB_URL, max: 1, connectionTimeoutMillis: 2000 })
    try {
      const client = await tmp.connect()
      await client.query('SELECT 1')
      client.release()
      await tmp.end()
      return
    } catch {
      await tmp.end().catch(() => {})
      await new Promise(r => setTimeout(r, 500))
    }
  }
  throw new Error(`[test-db] not reachable after ${timeoutMs}ms at ${TEST_DB_URL}`)
}
