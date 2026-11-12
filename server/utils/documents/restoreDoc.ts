import * as Y from 'yjs'
import jwt from 'jsonwebtoken'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { Awareness } from 'y-protocols/awareness'
import { withTransaction } from '../../repos/transaction'
import type { DocAccess } from '../../repos/proofs'
import { reconstructDocAtYjsId } from './historyReplay'
import { latestYjsIdIn, lockDocumentForRestore, YjsHistoryCompactedError } from '../../repos/yjsLog'
import { flushSyncDocument } from './syncNotify'
import { restoreClientUserId, type SessionJwtPayload } from '~~/shared/contracts/jwt'
import { isValidMetaValue } from '~~/shared/utils/documents/ymetaValidation'
import { useEnv } from '~~/shared/env/load'

const RESTORABLE_META_KEYS = ['title', 'theme', 'description', 'audience', 'language', 'templateId'] as const

/**
 * The past state's restorable ymeta values as plain JS. Only values that
 * pass the sync server's ymeta validation are returned — the server
 * rejects (and closes the connection on) an update carrying anything
 * else, which would fail the whole restore. A past theme that no longer
 * matches today's schema, or a corrupted value (e.g. a nested Y type),
 * is skipped: the doc keeps its current value for that key. Values are
 * read per key — never `toJSON()` on the whole map, which recurses into
 * nested Y types without a depth bound.
 */
export function readRestorableMeta(pastMeta: Y.Map<unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of RESTORABLE_META_KEYS) {
    if (!pastMeta.has(k)) continue
    const v = pastMeta.get(k)
    if (v instanceof Y.AbstractType) continue
    if (isValidMetaValue(k, v)) out[k] = v
  }
  return out
}

// "Snap the live Y.Doc to a past state" — the execution side of restore.
//
// Mechanics:
//   1. Replay the Y.js log up to `targetYjsId` to produce the past
//      state's full Y.Doc (no in-memory references to the live doc).
//   2. Connect a synthetic Hocuspocus client to the live doc as the
//      acting user. Mirrors the AI-session pattern (`aiClient.ts`):
//      JWT carries readOnly:false + userName so awareness rendering
//      shows "Joel restored" to collaborators in real time.
//   3. Inside ONE Y.js transaction (origin `restore:{userId}:{sessionId}`),
//      replace ytext + ymeta + ycomments with the past state's
//      content. The transaction shows up to every connected client
//      as a single broadcast — no flicker, no partial state.
//   4. Wait until the sync server acknowledged the update, have it
//      store the document now (`flush-document`) and read the newest
//      row id: the row the restore wrote, so the `restore` activity
//      row's boundaries diff (and undo) exactly this change.
//   5. Disconnect the synthetic client. The live doc now reflects
//      the target state; collaborators' editors update via the
//      normal y-codemirror.next bind.
//
// Concurrency: per-doc serialization via Postgres advisory-xact lock.
// Two parallel restore requests for the same doc would compute
// inverses against incompatible "live" snapshots and produce a
// last-write-wins result that's hard to reason about. The lock
// guarantees the second restore observes the first one's effect
// and either succeeds (against the new live state) or contends
// (returns 409 from the endpoint).
//
// What does NOT live here:
//   - Auth (caller's responsibility — `requireDocEditAccess` in the
//     endpoint runs first)
//   - The activity-log row write (caller writes it after success
//     so a replay-time exception leaves no orphan)

const ACK_TIMEOUT_MS = 10_000

/**
 * Resolves once the sync server has applied every update this provider
 * sent (Hocuspocus answers each one with a sync-status message). Rejects
 * when that takes longer than `ACK_TIMEOUT_MS` — e.g. the server refused
 * the update.
 */
function waitForServerAck(provider: HocuspocusProvider): Promise<void> {
  if (!provider.hasUnsyncedChanges) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onChange = () => {
      if (provider.hasUnsyncedChanges) return
      clearTimeout(timer)
      provider.off('unsyncedChanges', onChange)
      resolve()
    }
    const timer = setTimeout(() => {
      provider.off('unsyncedChanges', onChange)
      reject(new Error(`Restore update not acknowledged by the sync server within ${ACK_TIMEOUT_MS}ms`))
    }, ACK_TIMEOUT_MS)
    provider.on('unsyncedChanges', onChange)
  })
}

export interface RestoreDocOptions {
  /** Write access to the document being restored (the route's proof). */
  doc: DocAccess<'write'>
  /** `yjs_updates` id whose state we'll restore the live doc to.
   *  In the endpoint this is the source activity row's `yjsDocIdBefore`
   *  — i.e., "the state right before that activity happened." */
  targetYjsId: number
  /** Real human user requesting the restore — drives JWT identity
   *  + the awareness label collaborators see. */
  actorUserId: number
  actorName: string
  /** Synthetic short id used to namespace the JWT principal +
   *  Y.js transaction origin. Generated by the endpoint per call. */
  sessionId: string
}

export interface RestoreDocResult {
  /** The `yjs_updates` id captured BEFORE the restore landed —
   *  i.e., the live state right before our inverse update. Stamped
   *  on the new restore activity row's `yjsDocIdBefore` so a FUTURE
   *  restore from this row brings the doc back to the pre-restore
   *  state. THIS is the field that powers reversibility. */
  yjsDocIdBeforeRestore: number | null
  /** The `yjs_updates` id after the restore was stored (the sync
   *  server is made to store it before this is read). Used to set
   *  yjsDocIdAfter on the resulting `restore` activity row so its diff
   *  drawer can replay the exact change. */
  yjsDocIdAfterRestore: number | null
}

/**
 * Thrown when the restore target sits below the document's history floor:
 * the sync server pruned the Y.js rows it needs (COMPACT_RETAIN_HISTORY_DAYS),
 * so that state can't be reconstructed. The endpoint maps this to 410 Gone.
 */
export class RestorePointCompactedError extends Error {
  constructor(public readonly targetYjsId: number, public readonly floorId: number) {
    super(
      `Restore target yjs id ${targetYjsId} is below the compaction floor ${floorId}: `
      + 'its granular history has been merged away and can no longer be reconstructed.'
    )
    this.name = 'RestorePointCompactedError'
  }
}

/**
 * Snap the live Y.Doc to the state at `targetYjsId`. Throws on
 * timeout / WS auth failure / replay failure. The live doc is
 * unchanged on any error (Y.js transactions are atomic).
 */
export async function restoreDocToYjsId(opts: RestoreDocOptions): Promise<RestoreDocResult> {
  const env = useEnv()
  if (!env.auth.jwtSecret) throw new Error('JWT secret not configured')

  const docId = opts.doc.docId
  // Per-doc serialization. The lock is held for the lifetime of
  // this transaction — which we keep open for the whole restore
  // duration via a long-running select. That seems heavy but
  // restores are infrequent (manual user action) and short
  // (~250ms in practice).
  return await withTransaction(async (tx) => {
    await lockDocumentForRestore(opts.doc, tx)

    // Capture the live state's max yjs row id BEFORE we touch the doc.
    // This is what makes restores reversible: stamping it on the
    // resulting activity row's `yjsDocIdBefore` means a future restore
    // from THIS row brings the doc back to the pre-restore state.
    const yjsDocIdBeforeRestore = await latestYjsIdIn(opts.doc, tx)

    // Step 1: replay to get the past state's full Y.Doc, then EXTRACT
    // the values we want to restore (text, comments, meta) as plain
    // JS values. We deliberately do NOT use the past doc's encoded
    // update — see the rationale at the apply site below.
    // Below the history floor the replay throws instead of returning an
    // empty doc — applying an empty reconstruction would WIPE the live doc.
    let past: Y.Doc
    try {
      past = await reconstructDocAtYjsId(opts.doc, opts.targetYjsId)
    } catch (e) {
      if (e instanceof YjsHistoryCompactedError) throw new RestorePointCompactedError(opts.targetYjsId, e.floorId)
      throw e
    }
    const pastText = past.getText('content').toJSON()
    const pastComments = past.getArray('comments').toJSON() as unknown[]
    const pastMeta = readRestorableMeta(past.getMap('meta'))
    past.destroy()

    // Step 2: open a synthetic Hocuspocus client as the acting user.
    const payload = {
      docId: docId,
      // Distinct synthetic principal so attribution can tell a
      // restore apart from a regular edit by the same user.
      // Format mirrors the AI session's `ai:assistant:*`.
      userId: restoreClientUserId(opts.actorUserId, opts.sessionId),
      userName: opts.actorName,
      readOnly: false
    } satisfies SessionJwtPayload
    const token = jwt.sign(payload, env.auth.jwtSecret, { expiresIn: '5m' })

    const ydoc = new Y.Doc()
    const awareness = new Awareness(ydoc)
    awareness.setLocalStateField('user', { name: opts.actorName, color: '#888' })

    const wsUrl = env.sync.internalUrl.replace(/^http(s?):\/\//, 'ws$1://')

    let syncResolved = false
    let resolveSync!: () => void
    let rejectSync!: (e: Error) => void
    const syncReady = new Promise<void>((resolve, reject) => {
      resolveSync = resolve
      rejectSync = reject
    })
    const timer = setTimeout(() => {
      if (syncResolved) return
      syncResolved = true
      rejectSync(new Error('Restore sync timeout (10s)'))
    }, 10_000)

    const provider = new HocuspocusProvider({
      url: wsUrl,
      name: docId,
      document: ydoc,
      awareness,
      token,
      onSynced: () => {
        if (syncResolved) return
        syncResolved = true
        clearTimeout(timer)
        resolveSync()
      },
      onAuthenticationFailed: (data) => {
        if (syncResolved) return
        syncResolved = true
        clearTimeout(timer)
        rejectSync(new Error('Restore auth failed: ' + (data?.reason || 'unknown')))
      },
      onClose: (data) => {
        if (syncResolved) return
        const evt = (data as { event?: { code?: number, reason?: string } })?.event
        syncResolved = true
        clearTimeout(timer)
        rejectSync(new Error(`Restore conn closed: ${evt?.code} ${evt?.reason || ''}`))
      }
    })

    let yjsDocIdAfterRestore: number | null
    try {
      await syncReady

      // Step 3: replace state inside one transaction. `Y.applyUpdate(ydoc,
      // pastUpdate)` would not work: Y.js merges by item id (clientID,
      // clock), and the past and live docs share item ids. Deleting the
      // live items first tombstones those ids in this transaction, so the
      // past update's items count as already deleted and the doc ends up
      // empty.
      //
      // Instead, empty the shared collections and INSERT fresh items
      // carrying the past VALUES. Character-level CRDT history is lost
      // (the text is one freshly typed run) but the doc reads exactly as
      // it did at the target row, and the new restore row's boundary ids
      // let a reverse restore work the same way.
      ydoc.transact(() => {
        const ytext = ydoc.getText('content')
        ytext.delete(0, ytext.length)
        if (pastText.length > 0) ytext.insert(0, pastText)

        const ycomments = ydoc.getArray('comments')
        if (ycomments.length > 0) ycomments.delete(0, ycomments.length)
        // Comment threads are Y.Map instances inside the array; we
        // re-insert them as plain Y.Maps populated from the past JSON
        // so anchors / replies survive. RelativePosition base64s land
        // verbatim — they reference the OLD ytext item ids and become
        // orphaned anchors in the read endpoint, which is the same
        // behaviour the user sees if a passage is deleted manually.
        for (const c of pastComments) {
          if (c && typeof c === 'object') {
            const m = new Y.Map<unknown>()
            for (const [k, v] of Object.entries(c as Record<string, unknown>)) {
              m.set(k, v)
            }
            ycomments.push([m])
          }
        }

        // ymeta: copy past values for title/theme/description/audience/
        // language/templateId. Transient keys (_deleted, presence flags)
        // are deliberately NOT touched — restoring a deleted-marker
        // would re-delete the doc.
        const ymeta = ydoc.getMap('meta')
        for (const [k, v] of Object.entries(pastMeta)) {
          ymeta.set(k, v)
        }
      }, `restore:${opts.actorUserId}:${opts.sessionId}`)

      // Step 4: the update is in the sync server's document once it
      // acknowledged it; then make it store the document now instead of
      // after its 2 s debounce, and read the row that store appended.
      // A failed flush is logged by flushSyncDocument; the id read below
      // may then precede the restore's own row.
      await waitForServerAck(provider)
      await flushSyncDocument(docId)
      yjsDocIdAfterRestore = await latestYjsIdIn(opts.doc, tx)
    } finally {
      try {
        awareness.setLocalState(null)
      } catch {
        /* best-effort */
      }
      try {
        provider.disconnect()
      } catch {
        /* best-effort */
      }
      try {
        provider.destroy()
      } catch {
        /* best-effort */
      }
      try {
        ydoc.destroy()
      } catch {
        /* best-effort */
      }
    }

    return { yjsDocIdBeforeRestore, yjsDocIdAfterRestore }
  })
}
