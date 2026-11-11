import * as Y from 'yjs'
import { Pool } from 'pg'
import { postgresUrlFromEnv } from '../../shared/utils/runtime/connectionStrings'
import { resolvePostgresSsl } from '../../shared/utils/runtime/postgresSsl'
import { captureException } from './sentry'

// Background compaction of the `yjs_documents` append-log.
//
// WHY THIS EXISTS — the on-load compaction isn't enough:
// y-postgresql appends one `v1` row per Hocuspocus store (every 2-10 s
// debounce while a doc is edited) and only ever MERGES those rows inside
// `getYDocFromDb` — i.e. when a document is LOADED from the DB. Hocuspocus
// keeps a doc's `Y.Doc` in memory for as long as any client is connected,
// so a continuously-edited document is never re-loaded and its row count
// grows without bound. This sweep periodically merges the granular rows of
// such "always-loaded" documents into a single compacted row.
//
// RACE-SAFETY — why we do NOT reuse the library's `flushDocument`:
// `flushDocument` deletes `id < mergedRowId`. Run from a process that isn't
// serialized with the writer, that deletes any update appended between the
// read and the merge → silent document data loss. Instead we snapshot a
// `ceiling = MAX(id)` BEFORE reading, merge rows with `id <= ceiling`,
// insert the merged row (which gets a NEW id > ceiling), and delete ONLY
// `id <= ceiling` — atomically, in one transaction. Any update a live
// writer appends concurrently has `id > ceiling`, so it is never folded
// into the merge AND never deleted; it simply layers on top of the merged
// row on the next load (Y.js updates are commutative + idempotent). Safe
// against concurrent appends from any process, single- or multi-instance.
//
// INTERACTION WITH RESTORE (F4): compaction raises `MIN(id)` for the doc,
// so activity-log restore points below the new floor become unavailable —
// `restoreDoc` already guards this with `RestorePointCompactedError`. This
// is the same tradeoff the on-load compaction has always had; the sweep
// just applies it to always-loaded docs too.

// Only compact docs whose granular `v1` row count exceeds this. Kept above
// y-postgresql's flushSize (200) so we target genuinely-bloated always-
// loaded docs, not ones the on-load path would compact anyway. Each `v1`
// row ≈ one 2-10 s edit batch, so 500 retains a generous per-doc restore
// window between compactions.
const COMPACT_THRESHOLD = Number.parseInt(process.env.COMPACT_THRESHOLD || '500')
// How often the sweep runs. `<= 0` disables it entirely.
const COMPACT_INTERVAL_MS = Number.parseInt(process.env.COMPACT_INTERVAL_MS || '900000')
// Cap docs compacted per run so one sweep can't monopolise the DB / a
// connection for minutes on a table with many bloated docs.
const COMPACT_MAX_DOCS_PER_RUN = Number.parseInt(process.env.COMPACT_MAX_DOCS_PER_RUN || '50')
// Advisory-lock name (hashed in SQL, same convention as the app sweepers)
// so only one sync-server instance sweeps at a time.
const COMPACT_LOCK_NAME = 'yjs-compaction-sweep'

// Dedicated small pool — separate from y-postgresql's internal pool and
// from persistence.ts's `queryPool`. Compaction deliberately does NOT go
// through y-postgresql's per-doc `_transact` queue: the MAX(id)-ceiling
// design (above) is what makes it safe, so it needs its own connections.
// Lazily created on first use so importing the pure `mergeUpdates` helper
// (e.g. from unit tests) doesn't require the Postgres env to be present.
let _pool: Pool | null = null
function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool({
      connectionString: postgresUrlFromEnv(),
      max: 4,
      ssl: resolvePostgresSsl()
    })
  }
  return _pool
}

/**
 * Merge a doc's granular Y.js updates into one equivalent update. Pure —
 * exported so the CRDT-correctness core (that a merge preserves state, and
 * that a not-yet-merged concurrent update still applies on top) is unit-
 * testable without a database.
 */
export function mergeUpdates(updates: Uint8Array[]): Uint8Array {
  const ydoc = new Y.Doc()
  try {
    ydoc.transact(() => {
      for (const u of updates) Y.applyUpdate(ydoc, u)
    })
    return Y.encodeStateAsUpdate(ydoc)
  } finally {
    ydoc.destroy()
  }
}

export interface CompactionResult {
  rowsMerged: number
  rowsDeleted: number
}

/**
 * Compact a single document. Returns null when there's nothing to do (doc
 * absent, or already ≤ 1 granular row). See the race-safety note at the top
 * of the file for why the ceiling read and the delete bound are what they
 * are — do not "simplify" them to the library's `flushDocument` shape.
 */
async function compactDocument(docName: string): Promise<CompactionResult | null> {
  // 1) Snapshot the concurrency boundary BEFORE reading. Anything a live
  //    writer appends after this has id > ceiling and must survive untouched.
  const ceilRes = await getPool().query<{ max_id: number | null }>(
    `SELECT MAX(id) AS max_id FROM yjs_documents WHERE docname = $1 AND version = 'v1'`,
    [docName]
  )
  const ceiling = ceilRes.rows[0]?.max_id
  if (typeof ceiling !== 'number') return null

  // 2) Read the granular rows up to the ceiling and rebuild the state.
  const rowsRes = await getPool().query<{ value: Buffer }>(
    `SELECT value FROM yjs_documents WHERE docname = $1 AND version = 'v1' AND id <= $2 ORDER BY id`,
    [docName, ceiling]
  )
  if (rowsRes.rows.length <= 1) return null // nothing to gain

  const merged = Buffer.from(mergeUpdates(rowsRes.rows.map(r => Uint8Array.from(r.value))))

  // 3) Insert the merged snapshot (new id > ceiling) and delete only the
  //    rows we merged — atomically. Concurrent appends (id > ceiling) are
  //    outside both the INSERT's new id and the DELETE's range, so they
  //    ride through untouched and layer on top of the merged row on load.
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO yjs_documents (docname, value, version) VALUES ($1, $2, 'v1')`,
      [docName, merged]
    )
    const del = await client.query(
      `DELETE FROM yjs_documents WHERE docname = $1 AND version = 'v1' AND id <= $2`,
      [docName, ceiling]
    )
    await client.query('COMMIT')
    return { rowsMerged: rowsRes.rows.length, rowsDeleted: del.rowCount ?? 0 }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => { /* best-effort */ })
    throw e
  } finally {
    client.release()
  }
}

/**
 * One sweep: find bloated docs and compact each. Guarded by a session-
 * scoped advisory lock so only one instance runs at a time (compaction is
 * safe even if two raced, but the lock avoids the wasted work). Per-doc
 * failures are logged + captured and don't abort the run.
 */
async function runCompactionSweep(): Promise<void> {
  const lockClient = await getPool().connect()
  try {
    const got = await lockClient.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      [COMPACT_LOCK_NAME]
    )
    if (!got.rows[0]?.locked) return // another instance holds the sweep lock

    try {
      const candidates = await getPool().query<{ docname: string }>(
        `SELECT docname FROM yjs_documents
         WHERE version = 'v1'
         GROUP BY docname
         HAVING COUNT(*) > $1
         LIMIT $2`,
        [COMPACT_THRESHOLD, COMPACT_MAX_DOCS_PER_RUN]
      )
      let compacted = 0
      let rowsReclaimed = 0
      for (const { docname } of candidates.rows) {
        try {
          const r = await compactDocument(docname)
          if (r) {
            compacted++
            // Net rows removed = merged-away granular rows minus the one
            // merged row we inserted.
            rowsReclaimed += r.rowsDeleted - 1
          }
        } catch (e) {
          console.error(`[compaction] failed for ${docname}:`, e instanceof Error ? e.message : e)
          captureException(e, { tags: { component: 'compaction', event: 'doc_failed', docId: docname } })
        }
      }
      if (compacted > 0) {
        console.log(`[compaction] compacted ${compacted} document(s), reclaimed ~${rowsReclaimed} rows`)
      }
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', [COMPACT_LOCK_NAME])
        .catch(() => { /* best-effort — the session ending releases it anyway */ })
    }
  } catch (e) {
    console.error('[compaction] sweep error:', e instanceof Error ? e.message : e)
    captureException(e, { tags: { component: 'compaction', event: 'sweep_failed' } })
  } finally {
    lockClient.release()
  }
}

let sweepTimer: ReturnType<typeof setInterval> | null = null
let sweeping = false

/** Start the periodic compaction sweep. Idempotent; no-op if disabled. */
export function startCompactionSweeper(): void {
  if (COMPACT_INTERVAL_MS <= 0) {
    console.log('[compaction] sweeper disabled (COMPACT_INTERVAL_MS <= 0)')
    return
  }
  if (sweepTimer) return
  sweepTimer = setInterval(() => {
    if (sweeping) return // never overlap runs
    sweeping = true
    void runCompactionSweep().finally(() => {
      sweeping = false
    })
  }, COMPACT_INTERVAL_MS)
  // Don't let the timer alone keep the process alive on shutdown.
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref()
  console.log(`[compaction] sweeper started (every ${Math.round(COMPACT_INTERVAL_MS / 1000)}s, threshold ${COMPACT_THRESHOLD} rows)`)
}

/** Stop the sweeper and close its pool (graceful shutdown). */
export async function stopCompactionSweeper(): Promise<void> {
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
  if (_pool) {
    await _pool.end().catch(() => { /* best-effort */ })
    _pool = null
  }
}
