import * as Y from 'yjs'

// The `yjs_updates` table (server/db/schema/sync.ts): every SQL statement the sync
// server runs against it. No env, Sentry or Hocuspocus in here, so the repos
// test tier drives it against a real Postgres.
//
// Layout: an append-only log per document. `update` rows are Y.js updates;
// a `snapshot` row holds the merged state of every row of its document with a
// smaller id. The state at id X = every row with id <= X applied = the newest
// snapshot <= X plus the updates after it.
//
// Locking: every write holds `pg_advisory_xact_lock(YJS_LOCK_NAMESPACE,
// hashtext(doc_id))` from before its INSERT until COMMIT. Two consequences the
// rest of the design rests on:
//   - within a document, ids are committed in increasing order, so the newest
//     id read under the lock is the state right before the write (the activity
//     log's "before" boundary), and no row with a smaller id can appear later;
//   - a snapshot written under the lock really covers every row below its id.
// Writers on different documents never wait for each other. The app's writer
// (`server/utils/documents/yjsLog.ts`) uses the same namespace, keep the two
// in step.

/** First key of the per-document advisory lock (the second is hashtext(doc_id)). */
export const YJS_LOCK_NAMESPACE = 7_955_315

const FOREIGN_KEY_VIOLATION = '23503'

interface QueryResult<R> {
  rows: R[]
  rowCount: number | null
}

/** The subset of `pg.Pool` / `pg.PoolClient` this module uses. */
export interface Queryable {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<R>>
}

export interface PoolClientLike extends Queryable {
  release(err?: Error | boolean): void
}

export interface PoolLike extends Queryable {
  connect(): Promise<PoolClientLike>
}

/** The document row is gone (deleted): its Y.js state must not be written back. */
export class DocumentGoneError extends Error {
  constructor(public readonly docId: string) {
    super(`document ${docId} does not exist (deleted?)`)
    this.name = 'DocumentGoneError'
  }
}

/** A row larger than any legitimate document state; refused before it reaches Postgres. */
export class RowTooLargeError extends Error {
  constructor(public readonly docId: string, public readonly bytes: number, public readonly limit: number) {
    super(`Y.js row for ${docId} is ${bytes} bytes (limit ${limit})`)
    this.name = 'RowTooLargeError'
  }
}

interface LogRow {
  id: string | number
  kind: 'update' | 'snapshot'
  data: Buffer
}

export interface LoadedDocument {
  doc: Y.Doc
  /** Update rows after the newest snapshot: how much a new snapshot would save. */
  updatesSinceSnapshot: number
  /** Bytes read. */
  bytes: number
  /** Rows that could not be applied (logged by the caller, kept in the table). */
  unreadableRowIds: number[]
}

export interface AppendResult {
  /** The id of the row just written. */
  id: number
  /** The document's newest row id before this write (null: first row). */
  previousId: number | null
}

export interface SnapshotResult {
  id: number
  /** Update rows the snapshot folds in (since the previous snapshot). */
  updatesMerged: number
  bytes: number
}

function toBytes(buf: Buffer): Uint8Array {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

function isForeignKeyViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === FOREIGN_KEY_VIOLATION
}

// Rows from the newest snapshot on (or every row when there is none). One
// statement, so it sees one consistent view of the log.
const LATEST_STATE_SQL = `
  SELECT id, kind, data FROM yjs_updates
  WHERE doc_id = $1
    AND id >= COALESCE((SELECT max(id) FROM yjs_updates WHERE doc_id = $1 AND kind = 'snapshot'), 0)
  ORDER BY id`

/** Apply rows in id order; rows that can't be decoded are reported, not fatal. */
function applyRows(doc: Y.Doc, rows: LogRow[]): { bytes: number, updates: number, unreadable: number[] } {
  let bytes = 0
  let updates = 0
  const unreadable: number[] = []
  doc.transact(() => {
    for (const row of rows) {
      bytes += row.data.byteLength
      if (row.kind === 'update') updates++
      try {
        Y.applyUpdate(doc, toBytes(row.data))
      } catch {
        unreadable.push(Number(row.id))
      }
    }
  })
  return { bytes, updates, unreadable }
}

async function lockDocument(client: Queryable, docId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [YJS_LOCK_NAMESPACE, docId])
}

async function newestId(client: Queryable, docId: string): Promise<number | null> {
  const r = await client.query<{ id: string | number | null }>(
    'SELECT max(id) AS id FROM yjs_updates WHERE doc_id = $1',
    [docId]
  )
  const v = r.rows[0]?.id
  return v === null || v === undefined ? null : Number(v)
}

/** Run `fn` in a transaction holding the document's write lock. */
async function withDocumentLock<T>(pool: PoolLike, docId: string, fn: (client: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  let broken = false
  try {
    await client.query('BEGIN')
    await lockDocument(client, docId)
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (e) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // The connection itself is broken: don't hand it back to the pool.
      broken = true
    }
    if (isForeignKeyViolation(e)) throw new DocumentGoneError(docId)
    throw e
  } finally {
    client.release(broken)
  }
}

export interface YjsStoreOptions {
  /** Largest row accepted (a whole document's state is bounded by SYNC_MAX_DOCUMENT_BYTES). */
  maxRowBytes: number
}

export function createYjsStore(pool: PoolLike, opts: YjsStoreOptions) {
  return {
    /**
     * The document's current state: newest snapshot plus the updates after
     * it. A document without rows loads empty. Rows below the snapshot (not
     * pruned yet, or kept for history) are not read.
     */
    async load(docId: string): Promise<LoadedDocument> {
      const res = await pool.query<LogRow>(LATEST_STATE_SQL, [docId])
      const doc = new Y.Doc()
      const applied = applyRows(doc, res.rows)
      return { doc, updatesSinceSnapshot: applied.updates, bytes: applied.bytes, unreadableRowIds: applied.unreadable }
    },

    /**
     * Append one update in its own transaction. Resolves only after COMMIT:
     * a resolved append is durable, a rejected one wrote nothing. Throws
     * `DocumentGoneError` when the document row no longer exists.
     */
    async append(docId: string, update: Uint8Array): Promise<AppendResult> {
      if (update.byteLength > opts.maxRowBytes) throw new RowTooLargeError(docId, update.byteLength, opts.maxRowBytes)
      return withDocumentLock(pool, docId, async (client) => {
        const previousId = await newestId(client, docId)
        const r = await client.query<{ id: string | number }>(
          `INSERT INTO yjs_updates (doc_id, kind, data) VALUES ($1, 'update', $2) RETURNING id`,
          [docId, Buffer.from(update.buffer, update.byteOffset, update.byteLength)]
        )
        const row = r.rows[0]
        if (!row) throw new Error('INSERT ... RETURNING returned no row')
        return { id: Number(row.id), previousId }
      })
    },

    /**
     * Write a snapshot of the document's current state. Returns null when
     * there is nothing to fold (fewer than two updates since the newest
     * snapshot) or another writer snapshotted meanwhile. Safe to run
     * concurrently with stores and with itself on other instances.
     *
     * The bulk of the log is read and merged WITHOUT the lock; under the
     * lock only the rows appended since (normally none or a few) are read
     * and applied, then the snapshot is inserted. The new snapshot's id is
     * above every row it saw, and the lock guarantees no smaller id commits
     * later: so it covers every row below it.
     */
    async writeSnapshot(docId: string): Promise<SnapshotResult | null> {
      const res = await pool.query<LogRow>(LATEST_STATE_SQL, [docId])
      const rows = res.rows
      const updates = rows.filter(r => r.kind === 'update').length
      if (updates < 2) return null
      const ceiling = Number(rows[rows.length - 1]?.id ?? 0)

      const doc = new Y.Doc()
      try {
        const applied = applyRows(doc, rows)
        // Never fold rows we could not read into a snapshot: pruning below
        // it would then delete them.
        if (applied.unreadable.length > 0) {
          throw new Error(`refusing to snapshot ${docId}: unreadable rows ${applied.unreadable.join(', ')}`)
        }
        return await withDocumentLock(pool, docId, async (client) => {
          const tail = await client.query<LogRow>(
            'SELECT id, kind, data FROM yjs_updates WHERE doc_id = $1 AND id > $2 ORDER BY id',
            [docId, ceiling]
          )
          // Another instance snapshotted since our read: its row already
          // covers everything we merged.
          if (tail.rows.some(r => r.kind === 'snapshot')) return null
          const more = applyRows(doc, tail.rows)
          if (more.unreadable.length > 0) {
            throw new Error(`refusing to snapshot ${docId}: unreadable rows ${more.unreadable.join(', ')}`)
          }
          const state = Y.encodeStateAsUpdate(doc)
          assertSameState(doc, state, docId)
          const r = await client.query<{ id: string | number }>(
            `INSERT INTO yjs_updates (doc_id, kind, data) VALUES ($1, 'snapshot', $2) RETURNING id`,
            [docId, Buffer.from(state.buffer, state.byteOffset, state.byteLength)]
          )
          const row = r.rows[0]
          if (!row) throw new Error('INSERT ... RETURNING returned no row')
          return { id: Number(row.id), updatesMerged: updates + more.updates, bytes: state.byteLength }
        })
      } finally {
        doc.destroy()
      }
    },

    /**
     * Delete the rows below the document's newest snapshot created at or
     * before `cutoff`. Afterwards the oldest row is that snapshot: ids from
     * it on stay replayable, older ids are gone (the history floor).
     * Returns the number of rows deleted.
     */
    async prune(docId: string, cutoff: Date): Promise<number> {
      return withDocumentLock(pool, docId, async (client) => {
        const keep = await client.query<{ id: string | number | null }>(
          `SELECT max(id) AS id FROM yjs_updates
           WHERE doc_id = $1 AND kind = 'snapshot' AND created_at <= $2`,
          [docId, cutoff]
        )
        const keepId = keep.rows[0]?.id
        if (keepId === null || keepId === undefined) return 0
        const del = await client.query('DELETE FROM yjs_updates WHERE doc_id = $1 AND id < $2', [docId, keepId])
        return del.rowCount ?? 0
      })
    },

    /** Documents with rows below a snapshot created at or before `cutoff`. */
    async pruneCandidates(cutoff: Date, limit: number): Promise<string[]> {
      const r = await pool.query<{ doc_id: string }>(
        `SELECT DISTINCT s.doc_id FROM yjs_updates s
         WHERE s.kind = 'snapshot' AND s.created_at <= $1
           AND EXISTS (SELECT 1 FROM yjs_updates o WHERE o.doc_id = s.doc_id AND o.id < s.id)
         LIMIT $2`,
        [cutoff, limit]
      )
      return r.rows.map(row => row.doc_id)
    }
  }
}

export type YjsStore = ReturnType<typeof createYjsStore>

/** The encoded snapshot must rebuild exactly the merged document. */
function assertSameState(doc: Y.Doc, state: Uint8Array, docId: string): void {
  const check = new Y.Doc()
  try {
    Y.applyUpdate(check, state)
    const a = Y.encodeStateVector(doc)
    const b = Y.encodeStateVector(check)
    const same = a.length === b.length && a.every((v, i) => v === b[i])
      && check.getText('content').toJSON() === doc.getText('content').toJSON()
    if (!same) throw new Error(`snapshot of ${docId} does not reproduce the merged state`)
  } finally {
    check.destroy()
  }
}
