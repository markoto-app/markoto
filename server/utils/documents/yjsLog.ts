import type { PoolClient } from 'pg'
import { useDatabasePool } from '../platform/database'

// The app's access to a document's Y.js log (`yjs_updates`, layout in
// server/db/schema.ts). The sync server writes it (sync-server/src/yjs-store.ts);
// the app reads it for history, duplicate, render, export and image GC, and
// writes the first row of a brand-new document (seed, duplicate).
//
// Replay rule: the state at id X is every row with id <= X applied, which is
// the newest snapshot <= X plus the updates after it.
//
// History floor: rows may be pruned below a snapshot (sync-server
// COMPACT_RETAIN_HISTORY_DAYS). The oldest row of a pruned document is that
// snapshot; ids from it on are replayable, older ids are not
// (`YjsHistoryCompactedError`). A document whose oldest row is an update was
// never pruned: an id below it is the empty state before the first write.

/** Same value as YJS_LOCK_NAMESPACE in sync-server/src/yjs-store.ts (pinned by a test). */
export const YJS_LOCK_NAMESPACE = 7_955_315

/** The requested point was pruned from the log and can't be reconstructed. */
export class YjsHistoryCompactedError extends Error {
  constructor(public readonly docId: string, public readonly targetId: number, public readonly floorId: number) {
    super(`yjs id ${targetId} of ${docId} is below the history floor ${floorId}`)
    this.name = 'YjsHistoryCompactedError'
  }
}

function toBytes(buf: Buffer): Uint8Array {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

function toId(v: string | number | null | undefined): number | null {
  return v === null || v === undefined ? null : Number(v)
}

/** The document's newest row id (its current state), or null without rows. */
export async function latestYjsId(docId: string): Promise<number | null> {
  const r = await useDatabasePool().query<{ id: string | null }>(
    'SELECT max(id) AS id FROM yjs_updates WHERE doc_id = $1',
    [docId]
  )
  return toId(r.rows[0]?.id)
}

/**
 * The rows that make up the state at `maxId`, in id order (empty when the
 * point lies before the first write). The floor check and the rows come from
 * ONE statement, so a concurrent prune can't remove rows between the two.
 * Throws `YjsHistoryCompactedError` below the history floor.
 */
export async function readYjsUpdatesAt(docId: string, maxId: number): Promise<Uint8Array[]> {
  const r = await useDatabasePool().query<{ floor: string | null, id: string | null, data: Buffer | null }>(
    `WITH f AS (
       SELECT (SELECT CASE WHEN kind = 'snapshot' THEN id END
               FROM yjs_updates WHERE doc_id = $1 ORDER BY id LIMIT 1) AS floor
     )
     SELECT f.floor, r.id, r.data
     FROM f LEFT JOIN LATERAL (
       SELECT id, data FROM yjs_updates
       WHERE doc_id = $1 AND id <= $2
         AND id >= COALESCE((SELECT max(id) FROM yjs_updates
                             WHERE doc_id = $1 AND kind = 'snapshot' AND id <= $2), 0)
     ) r ON true
     ORDER BY r.id`,
    [docId, maxId]
  )
  const floor = toId(r.rows[0]?.floor)
  if (floor !== null && maxId < floor) throw new YjsHistoryCompactedError(docId, maxId, floor)
  const out: Uint8Array[] = []
  for (const row of r.rows) if (row.data) out.push(toBytes(row.data))
  return out
}

/**
 * Every stored row in id order. Applying them one by one passes through every
 * state that can still be reconstructed (snapshots repeat state, which is
 * harmless). Used by the image GC to search all restorable versions.
 */
export async function readAllYjsUpdates(docId: string): Promise<Uint8Array[]> {
  const r = await useDatabasePool().query<{ data: Buffer }>(
    'SELECT data FROM yjs_updates WHERE doc_id = $1 ORDER BY id',
    [docId]
  )
  return r.rows.map(row => toBytes(row.data))
}

/**
 * Append one Y.js update for `docId` (the documents row must exist) under the
 * same per-document lock the sync server takes, in its own transaction.
 * Returns the new row's id.
 */
export async function appendYjsUpdate(docId: string, update: Uint8Array): Promise<number> {
  const client: PoolClient = await useDatabasePool().connect()
  let broken = false
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [YJS_LOCK_NAMESPACE, docId])
    const r = await client.query<{ id: string }>(
      `INSERT INTO yjs_updates (doc_id, kind, data) VALUES ($1, 'update', $2) RETURNING id`,
      [docId, Buffer.from(update.buffer, update.byteOffset, update.byteLength)]
    )
    await client.query('COMMIT')
    return Number(r.rows[0]?.id)
  } catch (e) {
    try {
      await client.query('ROLLBACK')
    } catch {
      broken = true
    }
    throw e
  } finally {
    client.release(broken)
  }
}
