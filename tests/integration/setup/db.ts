import { Pool } from 'pg'
import { TEST_DB_NAME, TEST_DB_URL } from './env'
import { first } from '../../helpers/assert'

// Test-side DB access. Separate pool from the Nuxt subprocess, we talk to
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
 * any table added to the app schema needs to be mirrored here, which is
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
      ai_job_units,
      ai_jobs,
      workspace_knowledge_chunks,
      workspace_knowledge,
      workspace_invites,
      document_shares,
      document_context_links,
      workspace_brand_assets,
      workspace_templates,
      document_view_days,
      custom_domains,
      published_pages,
      sso_grants,
      user_identities,
      sso_domains,
      sso_connections,
      workspace_subscriptions,
      ai_credit_grants,
      ai_credit_settlements,
      workspace_members,
      workspaces,
      yjs_updates,
      import_job_items,
      import_jobs,
      document_search,
      documents,
      folders,
      processed_webhook_events,
      pending_stripe_events,
      mcp_sessions,
      mcp_personal_tokens,
      ad_click_conversions,
      waitlist_signups,
      subscription_events,
      ai_spend_daily,
      user_ai_providers,
      moderation_notices,
      abuse_reports,
      users
    RESTART IDENTITY CASCADE
  `)
  // Wipe the test Valkey DB too. Without this, keys from the previous
  // test bleed across the boundary, the immediate symptom this fixed
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
 * Singleton ioredis client for test cleanup. Lazy + reused, opening
 * + closing per `resetDb()` call would slow the suite noticeably for
 * no benefit (the server is local).
 */
let _valkey: import('ioredis').default | null = null
async function getValkey() {
  if (_valkey) return _valkey
  const { default: Redis } = await import('ioredis')
  _valkey = new Redis('redis://:testpassword@127.0.0.1:6380/0', {
    // Tests run sequentially via vitest's worker, no need for the
    // default queueing behaviour. lazyConnect=false means the first
    // command implicitly connects.
    maxRetriesPerRequest: 1
  })
  return _valkey
}

async function resetValkey(): Promise<void> {
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
 * Append a Y.js update row for `docId` (its documents row must exist), as the
 * sync server would. Returns the row id.
 */
export async function insertYjsUpdate(docId: string, update: Uint8Array): Promise<number> {
  const r = await testDb().query<{ id: string }>(
    `INSERT INTO yjs_updates (doc_id, kind, data) VALUES ($1, 'update', $2) RETURNING id`,
    [docId, Buffer.from(update.buffer, update.byteOffset, update.byteLength)]
  )
  return Number(first(r.rows).id)
}

/** Every stored row of `docId`, in id order (apply them all for the current state). */
export async function readYjsRows(docId: string): Promise<Array<{ id: number, kind: 'update' | 'snapshot', data: Uint8Array }>> {
  const r = await testDb().query<{ id: string, kind: 'update' | 'snapshot', data: Buffer }>(
    'SELECT id, kind, data FROM yjs_updates WHERE doc_id = $1 ORDER BY id',
    [docId]
  )
  return r.rows.map(row => ({
    id: Number(row.id),
    kind: row.kind,
    data: new Uint8Array(row.data.buffer, row.data.byteOffset, row.data.byteLength)
  }))
}

/**
 * Block until the DB is reachable. Called by globalSetup before running
 * migrations: useful because docker-compose's healthcheck fires before
 * the first client connection is accepted (a few extra seconds of socket
 * readiness).
 */
export async function waitForDb(timeoutMs = 30_000): Promise<void> {
  const start = Date.now()
  // Fresh pool each retry, if the DB went away mid-wait, a cached pool
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
