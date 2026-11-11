import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { anonClient } from '../setup/client'
import { createDoc } from '../setup/fixtures'
import { TEST_INTERNAL_SECRET } from '../setup/env'
import { first } from '../../helpers/assert'

// Concurrency + isolation properties of the comments-snapshot
// endpoint. The endpoint reads the previous snapshot, diffs against
// the incoming one, replaces the mirror, then writes activity rows.
// Without proper transactional boundaries this sequence can produce:
//   - Duplicate activity events when two pushes race the read.
//   - Cross-doc bleed when a push for doc A references rows from
//     doc B (it shouldn't, but pin it).
//
// We test the OBSERVABLE behavior (final activity_log + comment
// mirror state) under concurrent and sequential pushes. The pure
// diff function is unit-tested separately; here we exercise the
// I/O plumbing and any locking we may need to add.

const secretHeaders = { 'x-internal-secret': TEST_INTERNAL_SECRET }

interface IncomingEntry {
  entryId: string
  parentCommentId?: string | null
  authorId?: number | null
  authorName: string
  body: string
  createdAt: number
  updatedAt: number
  resolved?: boolean
}

function makeEntry(overrides: Partial<IncomingEntry> & { entryId: string }): IncomingEntry {
  return {
    parentCommentId: null,
    authorId: null,
    authorName: 'Anon',
    body: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    resolved: false,
    ...overrides
  }
}

async function pushSnapshot(docId: string, entries: IncomingEntry[]): Promise<Response> {
  return anonClient().post(
    '/api/internal/comments-snapshot',
    { docId, entries },
    { headers: secretHeaders }
  )
}

async function listActivity(docId: string): Promise<Array<{ action: string, body_preview: string | null, comment_id: string | null }>> {
  const db = testDb()
  const r = await db.query<{ action: string, body_preview: string | null, comment_id: string | null }>(
    `SELECT action,
            COALESCE(metadata->>'bodyPreview', NULL) AS body_preview,
            COALESCE(metadata->>'commentId', NULL) AS comment_id
     FROM activity_log
     WHERE doc_id = $1
     ORDER BY id ASC`,
    [docId]
  )
  return r.rows
}

async function listMirror(docId: string): Promise<Array<{ entry_id: string, parent_comment_id: string | null, resolved: boolean }>> {
  const db = testDb()
  const r = await db.query<{ entry_id: string, parent_comment_id: string | null, resolved: boolean }>(
    'SELECT entry_id, parent_comment_id, resolved FROM document_comments WHERE doc_id = $1 ORDER BY entry_id',
    [docId]
  )
  return r.rows
}

describe('POST /api/internal/comments-snapshot — concurrency + isolation', () => {
  beforeEach(async () => {
    await resetDb()
  })

  describe('sequential pushes', () => {
    it('handles a full lifecycle (add root → add reply → resolve → reopen → delete reply → delete root)', async () => {
      // The canonical sanity check: every comment.* event fires
      // exactly once with the right metadata as the snapshot
      // transitions through the full lifecycle.
      const doc = await createDoc()

      // 1. Add root
      await pushSnapshot(doc.docId, [
        makeEntry({ entryId: 'root', authorName: 'Alice', body: 'root body' })
      ])

      // 2. Add reply
      await pushSnapshot(doc.docId, [
        makeEntry({ entryId: 'root', authorName: 'Alice', body: 'root body' }),
        makeEntry({
          entryId: 'reply',
          parentCommentId: 'root',
          authorName: 'Bob',
          body: 'reply body'
        })
      ])

      // 3. Resolve root
      await pushSnapshot(doc.docId, [
        makeEntry({ entryId: 'root', authorName: 'Alice', body: 'root body', resolved: true }),
        makeEntry({
          entryId: 'reply',
          parentCommentId: 'root',
          authorName: 'Bob',
          body: 'reply body'
        })
      ])

      // 4. Reopen root
      await pushSnapshot(doc.docId, [
        makeEntry({ entryId: 'root', authorName: 'Alice', body: 'root body', resolved: false }),
        makeEntry({
          entryId: 'reply',
          parentCommentId: 'root',
          authorName: 'Bob',
          body: 'reply body'
        })
      ])

      // 5. Delete reply
      await pushSnapshot(doc.docId, [
        makeEntry({ entryId: 'root', authorName: 'Alice', body: 'root body' })
      ])

      // 6. Delete root
      await pushSnapshot(doc.docId, [])

      const events = await listActivity(doc.docId)
      const kinds = events.map(e => e.action)
      expect(kinds).toEqual([
        'comment.added', // 1: root added
        'comment.replied', // 2: reply added
        'comment.resolved', // 3: root resolved
        'comment.reopened', // 4: root reopened
        'comment.deleted', // 5: reply deleted
        'comment.deleted' // 6: root deleted
      ])
      // Mirror should be empty after the final delete.
      expect(await listMirror(doc.docId)).toEqual([])
    })

    it('does NOT emit any events when the same snapshot is pushed twice', async () => {
      // Sync-server's own dedup short-circuits this case in production
      // (lastShipped fingerprint), but the endpoint must still be
      // idempotent if the dedup is bypassed (e.g. after a sync-server
      // restart that drops the in-memory map).
      const doc = await createDoc()
      const entries = [makeEntry({ entryId: 'a', body: 'hi' })]

      await pushSnapshot(doc.docId, entries)
      const beforeSecond = (await listActivity(doc.docId)).length

      await pushSnapshot(doc.docId, entries)
      const afterSecond = (await listActivity(doc.docId)).length

      expect(afterSecond).toBe(beforeSecond)
      // Mirror unchanged too — should still hold exactly one row.
      expect(await listMirror(doc.docId)).toHaveLength(1)
    })
  })

  describe('concurrent pushes (race window)', () => {
    it('two parallel pushes of the SAME prev → curr transition do not duplicate events', async () => {
      // SECURITY/CORRECTNESS: between the diff-read and the row-insert
      // there's a window where two concurrent identical pushes could
      // both observe the prev state, both compute the same events,
      // and both insert — yielding 2x the activity rows.
      //
      // Pure-function unit tests can't see this race; only an
      // integration test against real Postgres reveals it. Failing
      // this test means we need a transaction or advisory lock around
      // diff + replace + activity-write.
      const doc = await createDoc()

      // Stage state: "rootA exists." Both pushes will report
      // "rootA still exists, rootB now also exists" — observed prev
      // is identical for both.
      await pushSnapshot(doc.docId, [makeEntry({ entryId: 'rootA' })])

      const entriesAfter = [
        makeEntry({ entryId: 'rootA' }),
        makeEntry({ entryId: 'rootB', body: 'newcomer' })
      ]

      // Fire both simultaneously. Promise.all waits for both to
      // complete; the order in which they hit the endpoint is
      // determined by the event loop, not us.
      const [r1, r2] = await Promise.all([
        pushSnapshot(doc.docId, entriesAfter),
        pushSnapshot(doc.docId, entriesAfter)
      ])
      expect(r1.status).toBe(200)
      expect(r2.status).toBe(200)

      const addedEvents = (await listActivity(doc.docId))
        .filter(e => e.action === 'comment.added' && e.comment_id === 'rootB')
      // The semantic guarantee: exactly one comment.added event for
      // rootB, regardless of how many pushes claim "rootB is new".
      // (1 if the second push observed rootB already in the mirror
      //  and emitted nothing; 2 if both observed the OLD prev and
      //  emitted independently.) The 2 case is the bug we want to
      // catch when we add transactional protection.
      expect(addedEvents.length).toBeLessThanOrEqual(1)
    })

    it('parallel pushes for different docs are independent', async () => {
      // ISOLATION: pushes against doc A must not affect doc B's
      // activity log or comment mirror.
      const docA = await createDoc()
      const docB = await createDoc()

      const [resA, resB] = await Promise.all([
        pushSnapshot(docA.docId, [makeEntry({ entryId: 'a-only', body: 'A' })]),
        pushSnapshot(docB.docId, [makeEntry({ entryId: 'b-only', body: 'B' })])
      ])
      expect(resA.status).toBe(200)
      expect(resB.status).toBe(200)

      const aEvents = await listActivity(docA.docId)
      const bEvents = await listActivity(docB.docId)
      const aMirror = await listMirror(docA.docId)
      const bMirror = await listMirror(docB.docId)

      // Each doc sees exactly one comment.added pointing at its own
      // entry, nothing more.
      expect(aEvents).toEqual([
        expect.objectContaining({ action: 'comment.added', comment_id: 'a-only' })
      ])
      expect(bEvents).toEqual([
        expect.objectContaining({ action: 'comment.added', comment_id: 'b-only' })
      ])
      expect(aMirror).toEqual([
        expect.objectContaining({ entry_id: 'a-only' })
      ])
      expect(bMirror).toEqual([
        expect.objectContaining({ entry_id: 'b-only' })
      ])
    })
  })

  describe('idempotency of the replace-snapshot semantic', () => {
    it('a snapshot that DROPS an entry is exactly equivalent to a delete-event', async () => {
      // The snapshot-replace semantic means "missing from new" =
      // "deleted." Pin this so a future change (e.g. switching to
      // additive semantics) is a deliberate breaking change.
      const doc = await createDoc()
      await pushSnapshot(doc.docId, [
        makeEntry({ entryId: 'a' }),
        makeEntry({ entryId: 'b' }),
        makeEntry({ entryId: 'c' })
      ])

      // Second push omits 'b' — same effect as a delete event.
      await pushSnapshot(doc.docId, [
        makeEntry({ entryId: 'a' }),
        makeEntry({ entryId: 'c' })
      ])

      const events = await listActivity(doc.docId)
      const deletes = events.filter(e => e.action === 'comment.deleted')
      expect(deletes).toHaveLength(1)
      expect(first(deletes).comment_id).toBe('b')

      const mirror = await listMirror(doc.docId)
      expect(mirror.map(r => r.entry_id).sort()).toEqual(['a', 'c'])
    })

    it('an empty snapshot deletes everything mirrored', async () => {
      const doc = await createDoc()
      await pushSnapshot(doc.docId, [
        makeEntry({ entryId: 'x' }),
        makeEntry({ entryId: 'y' }),
        makeEntry({ entryId: 'z' })
      ])
      await pushSnapshot(doc.docId, [])

      const events = await listActivity(doc.docId)
      const deletes = events.filter(e => e.action === 'comment.deleted')
      expect(deletes.map(e => e.comment_id).sort()).toEqual(['x', 'y', 'z'])
      expect(await listMirror(doc.docId)).toEqual([])
    })
  })
})
