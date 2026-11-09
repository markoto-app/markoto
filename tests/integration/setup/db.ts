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
      audit_log,
      activity_log,
      uploads,
      ai_sessions,
      ai_session_messages,
      ai_session_provenance,
      workspace_knowledge_chunks,
      workspace_knowledge,
      workspace_invites,
      workspace_subscriptions,
      workspace_members,
      workspaces,
      documents,
      processed_webhook_events,
      pending_stripe_events,
      mcp_sessions,
      mcp_personal_tokens,
      waitlist_signups,
      user_ai_providers,
      moderation_notices,
      abuse_reports,
      users
    RESTART IDENTITY CASCADE
  `)
  // Drop any Y.js rows parked in the sync-server's table. `TRUNCATE
  // IF EXISTS` isn't valid Postgres syntax — we probe pg_tables first
  // and only issue the TRUNCATE when the table exists. This matters
  // for tests that seed yjs_documents directly (duplicate flow):
  // without a proper per-test reset, stale source rows bleed between
  // cases and assertions fail non-deterministically.
  const yjsExists = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'yjs_documents'
     ) AS exists`
  )
  if (yjsExists.rows[0].exists) {
    await db.query('TRUNCATE TABLE yjs_documents RESTART IDENTITY')
  }

  // Wipe the test Valkey DB too. Without this, keys from the previous
  // test bleed across the boundary — the immediate symptom this fixed
  // was aiDictateWs tests failing with `expected 4002, got 4001`.
  // Mechanism: `resetDb` runs `TRUNCATE ... RESTART IDENTITY`, so
  // user IDs reset to 1 between tests. The dictate WS lock key
  // `lock:ai-dictate-active:{userId}` from a previous test's user-1
  // was still alive when the next test's user-1 opened a session →
  // `tryAcquireSessionLock` returned false → server closed the WS
  // with 4001 ('session already active') BEFORE the budget check that
  // would have produced 4002. Other Valkey-backed surfaces (rate-
  // limit counters, single-flight locks, sweep locks, processed-event
  // dedup) are subject to the same bleed; flushing the whole DB is
  // the cheapest correct answer in a test setting.
  await resetValkey()
}

/**
 * Singleton ioredis client for test cleanup. Lazy + reused — opening
 * + closing per `resetDb()` call would slow the suite noticeably for
 * no benefit (the server is local).
 */
let _valkey: import('ioredis').default | null = null
async function getValkey() {
  if (_valkey) return _valkey
  const { default: Redis } = await import('ioredis')
  _valkey = new Redis('redis://:testpassword@127.0.0.1:6380/0', {
    // Tests run sequentially via vitest's worker — no need for the
    // default queueing behaviour. lazyConnect=false means the first
    // command implicitly connects.
    maxRetriesPerRequest: 1
  })
  return _valkey
}

export async function resetValkey(): Promise<void> {
  const client = await getValkey()
  await client.flushdb()
}

/** Delete one key from the test Valkey (e.g. a server-side cache entry). */
export async function deleteValkeyKey(key: string): Promise<void> {
  const client = await getValkey()
  await client.del(key)
}

/** Read one key from the test Valkey (null when absent). */
export async function getValkeyKey(key: string): Promise<string | null> {
  const client = await getValkey()
  return client.get(key)
}

/** Write one key into the test Valkey (no TTL). */
export async function setValkeyKey(key: string, value: string): Promise<void> {
  const client = await getValkey()
  await client.set(key, value)
}

export async function closeTestValkey(): Promise<void> {
  if (_valkey) {
    await _valkey.quit().catch(() => {})
    _valkey = null
  }
}

/**
 * Ensure the `yjs_documents` table exists. y-postgresql creates this
 * table lazily at sync-server startup (see
 * sync-server/node_modules/y-postgresql/src/pg-adapter.ts), but the
 * integration test environment doesn't run the sync-server — so any
 * code path that reads or writes `yjs_documents` (e.g. the document
 * duplicate flow) hits a "relation does not exist" error and 500s.
 *
 * Mirroring the schema here is the smallest fix that lets server
 * code exercise its real Y.js path under tests without spinning up
 * a separate sync-server. Idempotent via IF NOT EXISTS.
 */
export async function ensureYjsTable(): Promise<void> {
  const db = testDb()
  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ypga_version') THEN
        CREATE TYPE ypga_version AS ENUM ('v1', 'v1_sv');
      END IF;
    END
    $$;
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS yjs_documents (
      id SERIAL PRIMARY KEY,
      docname TEXT NOT NULL,
      value BYTEA NOT NULL,
      version ypga_version NOT NULL
    )
  `)
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
