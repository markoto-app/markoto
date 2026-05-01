import * as Y from 'yjs'
import { Pool } from 'pg'
import { PostgresqlPersistence } from 'y-postgresql'
import { postgresUrlFromEnv } from '../../shared/utils/connectionStrings'
import { resolvePostgresSsl } from '../../shared/utils/postgresSsl'
import { captureException } from './sentry'

const DATABASE_URL = postgresUrlFromEnv()
// Same TLS posture as the Nuxt app's pool (server/utils/database.ts).
// Both pools land on the same managed Postgres in prod; both must
// verify the server cert. y-postgresql's internal pool inherits this
// because we pass the resolved config object straight through to
// PostgresqlPersistence.build below.
const PG_SSL = resolvePostgresSsl()

// Small dedicated pool for ad-hoc queries against the yjs_documents
// table — separate from y-postgresql's internal pool because that
// library doesn't expose its connection. Used by getMaxYjsDocId so
// the activity log can stamp boundary ids around store events for the
// diff-on-demand feature.
const queryPool = new Pool({ connectionString: DATABASE_URL, max: 2, ssl: PG_SSL })

// y-postgresql owns its own table (`yjs_documents`); it appends granular Y.js
// updates and merges them after every `flushSize` writes. This is far more
// durable than the previous single-blob S3 overwrite — a failed write doesn't
// destroy the prior state, and granular history is implicit in the row log.
//
// useIndex is forced to `false` because y-postgresql@1.0.1 ships a SQL bug in
// the index-creation branch (`AND indexname = $1_docname_idx` — invalid pg
// parameter syntax). At our scale, reads are still fast enough without it; we
// can revisit if the upstream fixes it or if profiling demands an index.
// flushSize: 200 — library default; merges accumulated updates into a single
//   compacted update once the row count crosses the threshold per document.

const PERSISTENCE_OPTS = {
  tableName: 'yjs_documents',
  useIndex: false,
  flushSize: 200
} as const

async function buildPgdb() {
  return PostgresqlPersistence.build(
    // PostgresqlPersistence forwards this object straight to `new
    // pg.Pool(...)`, so the ssl key on PoolConfig propagates into the
    // library's internal pool. Verified: y-postgresql 1.0.1 takes
    // `pg.PoolConfig` and never overrides ssl.
    { connectionString: DATABASE_URL, ssl: PG_SSL },
    PERSISTENCE_OPTS
  )
}

let pgdb = await buildPgdb()

// Self-heal: y-postgresql checks-and-creates yjs_documents ONCE at boot.
// If the table later vanishes (manual `DROP`, `docker compose down -v` mid-
// session, dev reset that wipes the data dir while the sync container keeps
// running) every subsequent read/write fails with Postgres error 42P01
// "relation does not exist" — and the in-memory pool keeps re-issuing the
// same prepared statements forever. Detect it, rebuild the persistence (which
// re-runs the table-existence check + CREATE), and retry the operation once.
//
// We only retry once: if the table is missing AND can't be recreated, the
// underlying problem is fatal (DB unreachable, permissions, etc.) and a
// retry loop would just spin.

const RELATION_MISSING_CODE = '42P01'

function isMissingRelation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === RELATION_MISSING_CODE
}

async function withSelfHeal<T>(op: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (!isMissingRelation(e)) throw e
    console.warn(`[persistence] yjs_documents missing during ${op} — rebuilding pool to recreate it`)
    captureException(e, { tags: { component: 'persistence', event: 'self_heal', op } })
    // Drop the broken pool before rebuilding — y-postgresql's PgAdapter
    // owns a Pool that won't release its prepared statements until destroy.
    try {
      await pgdb.destroy()
    } catch {
      /* best-effort */
    }
    pgdb = await buildPgdb()
    return await fn()
  }
}

export const ypgPersistence = {
  async onLoadDocument({ documentName }: { documentName: string }) {
    try {
      const doc = await withSelfHeal(`load:${documentName}`, () => pgdb.getYDoc(documentName))
      console.log(`[persistence] Loaded document: ${documentName}`)
      return doc
    } catch (e) {
      console.error(`[persistence] Error loading ${documentName}:`, e instanceof Error ? e.message : e)
      captureException(e, { tags: { component: 'persistence', event: 'load_failed', docId: documentName } })
      // Re-throw so Hocuspocus rejects the connection. A previous version
      // returned a fresh Y.Doc here — which is catastrophic on transient
      // read failure: clients' cached Y.js state then persists back on
      // the next onStoreDocument as "new" writes, silently overwriting
      // the real document. Connection rejection makes clients reconnect
      // once the persistence layer recovers, preserving state.
      // (y-postgresql returns an empty Y.Doc for genuinely-absent rows
      // without throwing, so this branch only fires on real errors.)
      throw e
    }
  },

  async onStoreDocument({ documentName, document }: { documentName: string, document: Y.Doc }) {
    try {
      const update = Y.encodeStateAsUpdate(document)
      await withSelfHeal(`store:${documentName}`, () => pgdb.storeUpdate(documentName, update))
    } catch (e) {
      // Log loudly. Hocuspocus will retry on the next debounce tick; in the
      // meantime the in-memory Y.Doc is still the source of truth for
      // connected clients.
      console.error(`[persistence] Error storing ${documentName}:`, e instanceof Error ? e.message : e)
      captureException(e, { tags: { component: 'persistence', event: 'store_failed', docId: documentName } })
    }
  },

  async clearDocument(documentName: string): Promise<void> {
    await withSelfHeal(`clear:${documentName}`, () => pgdb.clearDocument(documentName))
  },

  /**
   * Returns the highest `yjs_documents.id` for this docname, or null
   * if the doc has no rows yet (fresh load before any store). Used by
   * the activity log to stamp boundary ids around each store event so
   * the diff endpoint can later replay the doc on either side of an
   * edit. Best-effort: returns null on any DB error (fail-soft so
   * activity logging never blocks sync).
   */
  async getMaxYjsDocId(documentName: string): Promise<number | null> {
    try {
      const r = await queryPool.query<{ max_id: number | null }>(
        'SELECT MAX(id) AS max_id FROM yjs_documents WHERE docname = $1',
        [documentName]
      )
      const v = r.rows[0]?.max_id
      return typeof v === 'number' ? v : null
    } catch (e) {
      // Table missing during a self-heal moment is the most common
      // case; we still return null and let activity logging skip the
      // boundary stamp. Don't capture to Sentry — it'd flood.
      console.warn(`[persistence] getMaxYjsDocId(${documentName}) failed:`, e instanceof Error ? e.message : e)
      return null
    }
  },

  async destroy(): Promise<void> {
    await pgdb.destroy()
    await queryPool.end()
  }
}
