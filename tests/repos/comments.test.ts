import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import {
  replaceCommentSnapshot,
  getCommentThreadByEntryId,
  type CommentSnapshotRow
} from '../../server/repos/comments'
import { createUser, createDoc as seedDoc } from '../integration/setup/fixtures'
import { first, must } from '../helpers/assert'

// Comments repo. Mirrors the doc's Y.js comment thread into Postgres via a
// transactional delete-then-insert (replaceCommentSnapshot), and offers a
// thread-resolution helper (getCommentThreadByEntryId) used by the
// activity-feed comment-context expansion.
//
// The repo exposes only two functions but BOTH operate on (docId, entryId)
// tuple keys, so the cross-doc isolation invariant from server/repos/AGENTS.md
// applies: an entryId from doc B must never resolve via doc A's id.

// Small helper — hand-roll the row shape so tests stay legible. The repo
// accepts dates in any order; we set explicit ms so ordering assertions
// can't be confused by setTimeout jitter.
function snapshotRow(overrides: Partial<CommentSnapshotRow> = {}): CommentSnapshotRow {
  const now = new Date('2025-01-01T00:00:00.000Z')
  return {
    entryId: overrides.entryId ?? 'entry-root',
    parentCommentId: overrides.parentCommentId ?? null,
    authorId: overrides.authorId ?? null,
    authorName: overrides.authorName ?? 'Test Author',
    body: overrides.body ?? 'Hello from a comment',
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    resolved: overrides.resolved ?? false
  }
}

async function countRows(docId: string): Promise<number> {
  const db = testDb()
  const r = await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM document_comments WHERE doc_id = $1`,
    [docId]
  )
  return Number(first(r.rows).n)
}

describe('replaceCommentSnapshot', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('inserts every row in the snapshot', async () => {
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    await replaceCommentSnapshot(doc.docId, [
      snapshotRow({ entryId: 'a', body: 'first', authorId: user.id, authorName: user.name }),
      snapshotRow({ entryId: 'b', body: 'second', authorId: user.id, authorName: user.name })
    ])
    expect(await countRows(doc.docId)).toBe(2)
  })

  it('replaces existing rows on second call (delete-then-insert)', async () => {
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    await replaceCommentSnapshot(doc.docId, [
      snapshotRow({ entryId: 'a', body: 'first' })
    ])
    expect(await countRows(doc.docId)).toBe(1)

    // Replace with a different shape entirely — old row must be gone.
    await replaceCommentSnapshot(doc.docId, [
      snapshotRow({ entryId: 'c', body: 'third' })
    ])
    expect(await countRows(doc.docId)).toBe(1)
    const db = testDb()
    const rows = await db.query<{ entry_id: string }>(
      `SELECT entry_id FROM document_comments WHERE doc_id = $1`,
      [doc.docId]
    )
    expect(first(rows.rows).entry_id).toBe('c')
  })

  it('clears the mirror when given an empty snapshot', async () => {
    // The sync server sends [] when the user clears the last comment;
    // the repo must persist that as a full delete, not a no-op.
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    await replaceCommentSnapshot(doc.docId, [
      snapshotRow({ entryId: 'a' }),
      snapshotRow({ entryId: 'b' })
    ])
    expect(await countRows(doc.docId)).toBe(2)
    await replaceCommentSnapshot(doc.docId, [])
    expect(await countRows(doc.docId)).toBe(0)
  })

  it('round-trips parent/reply structure verbatim', async () => {
    // Replies live in the same table with parentCommentId set; the
    // repo must preserve the link without rewriting it.
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    await replaceCommentSnapshot(doc.docId, [
      snapshotRow({ entryId: 'root-1', parentCommentId: null }),
      snapshotRow({ entryId: 'reply-1', parentCommentId: 'root-1' })
    ])
    const db = testDb()
    const rows = await db.query<{ entry_id: string, parent_comment_id: string | null }>(
      `SELECT entry_id, parent_comment_id FROM document_comments WHERE doc_id = $1 ORDER BY entry_id`,
      [doc.docId]
    )
    expect(rows.rows).toEqual([
      { entry_id: 'reply-1', parent_comment_id: 'root-1' },
      { entry_id: 'root-1', parent_comment_id: null }
    ])
  })

  it('preserves authorId, authorName, body, resolved, and timestamps', async () => {
    const user = await createUser({ name: 'Alice Author' })
    const doc = await seedDoc({ ownerId: user.id })
    const created = new Date('2025-03-01T10:00:00.000Z')
    const updated = new Date('2025-03-02T11:30:00.000Z')
    await replaceCommentSnapshot(doc.docId, [
      snapshotRow({
        entryId: 'a',
        authorId: user.id,
        authorName: user.name,
        body: 'body content',
        createdAt: created,
        updatedAt: updated,
        resolved: true
      })
    ])
    const db = testDb()
    const rows = await db.query<{
      author_id: number
      author_name: string
      body: string
      created_at_ms: Date
      updated_at_ms: Date
      resolved: boolean
    }>(
      `SELECT author_id, author_name, body, created_at_ms, updated_at_ms, resolved
       FROM document_comments WHERE doc_id = $1`,
      [doc.docId]
    )
    expect(first(rows.rows).author_id).toBe(user.id)
    expect(first(rows.rows).author_name).toBe(user.name)
    expect(first(rows.rows).body).toBe('body content')
    expect(first(rows.rows).created_at_ms.getTime()).toBe(created.getTime())
    expect(first(rows.rows).updated_at_ms.getTime()).toBe(updated.getTime())
    expect(first(rows.rows).resolved).toBe(true)
  })

  it('persists null authorId for an anonymous comment', async () => {
    // Anonymous editors on open-edit docs leave comments with authorId=null;
    // the column accepts NULL by schema design.
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    await replaceCommentSnapshot(doc.docId, [
      snapshotRow({ entryId: 'a', authorId: null, authorName: 'Anonymous' })
    ])
    const db = testDb()
    const rows = await db.query<{ author_id: number | null }>(
      `SELECT author_id FROM document_comments WHERE doc_id = $1`,
      [doc.docId]
    )
    expect(first(rows.rows).author_id).toBeNull()
  })

  it('rejects rows for a non-existent docId via the FK constraint', async () => {
    // FK on doc_id → documents.doc_id with onDelete: cascade. Insertion
    // against a missing doc must fail (no silent orphan write).
    await expect(
      replaceCommentSnapshot('does-not-exist', [snapshotRow({ entryId: 'a' })])
    ).rejects.toThrow()
    // And the row count for the bogus docId remains zero — the
    // transaction must roll back, not silently leave junk behind.
    expect(await countRows('does-not-exist')).toBe(0)
  })

  it('cross-doc isolation: replacing doc A leaves doc B untouched', async () => {
    // Critical: replaceCommentSnapshot is the doc-level mutating call. If
    // the WHERE on the delete leaked across docs, calling it for doc A
    // would wipe B's comments. This test pins the (docId)-scoped delete.
    const user = await createUser()
    const docA = await seedDoc({ ownerId: user.id })
    const docB = await seedDoc({ ownerId: user.id })
    await replaceCommentSnapshot(docA.docId, [snapshotRow({ entryId: 'a-1' })])
    await replaceCommentSnapshot(docB.docId, [
      snapshotRow({ entryId: 'b-1' }),
      snapshotRow({ entryId: 'b-2' })
    ])
    // Re-snapshot A. B's rows must still be there, untouched.
    await replaceCommentSnapshot(docA.docId, [snapshotRow({ entryId: 'a-2' })])
    expect(await countRows(docA.docId)).toBe(1)
    expect(await countRows(docB.docId)).toBe(2)

    // Clear A entirely. B still untouched.
    await replaceCommentSnapshot(docA.docId, [])
    expect(await countRows(docA.docId)).toBe(0)
    expect(await countRows(docB.docId)).toBe(2)
  })

  it('rolls back the whole transaction on a duplicate entryId within one snapshot', async () => {
    // Composite PK is (docId, entryId). Two rows in one snapshot with
    // matching entryId must abort the entire transaction — leaving the
    // mirror in its prior state, NOT half-applied.
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    await replaceCommentSnapshot(doc.docId, [snapshotRow({ entryId: 'pre-existing' })])
    expect(await countRows(doc.docId)).toBe(1)

    await expect(
      replaceCommentSnapshot(doc.docId, [
        snapshotRow({ entryId: 'dup' }),
        snapshotRow({ entryId: 'dup', body: 'second copy' })
      ])
    ).rejects.toThrow()
    // Transactional guarantee: the prior row stays, the failed insert
    // doesn't leave an empty doc behind.
    expect(await countRows(doc.docId)).toBe(1)
    const db = testDb()
    const rows = await db.query<{ entry_id: string }>(
      `SELECT entry_id FROM document_comments WHERE doc_id = $1`,
      [doc.docId]
    )
    expect(first(rows.rows).entry_id).toBe('pre-existing')
  })
})

describe('getCommentThreadByEntryId', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns null when the entryId does not exist for the doc', async () => {
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    expect(await getCommentThreadByEntryId(doc.docId, 'no-such-entry')).toBeNull()
  })

  it('returns null when the doc itself does not exist', async () => {
    expect(await getCommentThreadByEntryId('ghost-doc', 'whatever')).toBeNull()
  })

  it('returns the root + replies when called with the root entryId', async () => {
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    const t0 = new Date('2025-01-01T00:00:00.000Z')
    const t1 = new Date('2025-01-01T00:01:00.000Z')
    const t2 = new Date('2025-01-01T00:02:00.000Z')
    await replaceCommentSnapshot(doc.docId, [
      snapshotRow({ entryId: 'root', body: 'root post', createdAt: t0, updatedAt: t0 }),
      snapshotRow({ entryId: 'r1', parentCommentId: 'root', body: 'first reply', createdAt: t1, updatedAt: t1 }),
      snapshotRow({ entryId: 'r2', parentCommentId: 'root', body: 'second reply', createdAt: t2, updatedAt: t2 })
    ])
    const thread = await getCommentThreadByEntryId(doc.docId, 'root')
    expect(thread).not.toBeNull()
    expect(thread!.map(r => r.entryId)).toEqual(['root', 'r1', 'r2'])
  })

  it('walks the parent chain when called with a reply entryId', async () => {
    // "Resolve a thread by ANY entry id (root OR reply)" — calling with
    // a reply must still return the whole thread starting at the root.
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    const t0 = new Date('2025-01-01T00:00:00.000Z')
    const t1 = new Date('2025-01-01T00:01:00.000Z')
    const t2 = new Date('2025-01-01T00:02:00.000Z')
    await replaceCommentSnapshot(doc.docId, [
      snapshotRow({ entryId: 'root', body: 'root', createdAt: t0, updatedAt: t0 }),
      snapshotRow({ entryId: 'r1', parentCommentId: 'root', body: 'reply-1', createdAt: t1, updatedAt: t1 }),
      snapshotRow({ entryId: 'r2', parentCommentId: 'root', body: 'reply-2', createdAt: t2, updatedAt: t2 })
    ])
    const thread = await getCommentThreadByEntryId(doc.docId, 'r2')
    expect(thread).not.toBeNull()
    expect(thread!.map(r => r.entryId)).toEqual(['root', 'r1', 'r2'])
  })

  it('returns just the root for a single-comment thread (no replies)', async () => {
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    await replaceCommentSnapshot(doc.docId, [
      snapshotRow({ entryId: 'solo', body: 'lonely comment' })
    ])
    const thread = await getCommentThreadByEntryId(doc.docId, 'solo')
    expect(thread).not.toBeNull()
    expect(thread).toHaveLength(1)
    expect(first(must(thread)).entryId).toBe('solo')
    expect(first(must(thread)).parentCommentId).toBeNull()
  })

  it('orders replies chronologically by createdAt ASC', async () => {
    // Insert replies in non-monotonic order. The repo's ORDER BY must
    // restore createdAt-ascending so the activity feed shows the
    // conversation in real-world order.
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    const tRoot = new Date('2025-01-01T00:00:00.000Z')
    const tA = new Date('2025-01-01T00:00:10.000Z')
    const tB = new Date('2025-01-01T00:00:20.000Z')
    const tC = new Date('2025-01-01T00:00:30.000Z')
    await replaceCommentSnapshot(doc.docId, [
      // Insert in shuffled order — DB row order should not influence result.
      snapshotRow({ entryId: 'reply-c', parentCommentId: 'root', body: 'c', createdAt: tC, updatedAt: tC }),
      snapshotRow({ entryId: 'reply-a', parentCommentId: 'root', body: 'a', createdAt: tA, updatedAt: tA }),
      snapshotRow({ entryId: 'root', body: 'r', createdAt: tRoot, updatedAt: tRoot }),
      snapshotRow({ entryId: 'reply-b', parentCommentId: 'root', body: 'b', createdAt: tB, updatedAt: tB })
    ])
    const thread = await getCommentThreadByEntryId(doc.docId, 'root')
    expect(thread!.map(r => r.entryId)).toEqual(['root', 'reply-a', 'reply-b', 'reply-c'])
  })

  it('force-pins the root first even when its createdAt is later than a reply', async () => {
    // The repo explicitly defends against clock skew / edited timestamps:
    // even if the root's createdAt is later than a reply's, the root must
    // appear first. (See the trailing sort-by-rootId-first in the repo.)
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    const tEarly = new Date('2025-01-01T00:00:00.000Z')
    const tLate = new Date('2025-01-01T00:05:00.000Z')
    await replaceCommentSnapshot(doc.docId, [
      // Root's timestamp is LATER than the reply — pathological case.
      snapshotRow({ entryId: 'root', body: 'r', createdAt: tLate, updatedAt: tLate }),
      snapshotRow({ entryId: 'r1', parentCommentId: 'root', body: 'a', createdAt: tEarly, updatedAt: tEarly })
    ])
    const thread = await getCommentThreadByEntryId(doc.docId, 'root')
    expect(thread!.map(r => r.entryId)).toEqual(['root', 'r1'])
  })

  it('hydrates every CommentThreadRow field as the schema declares', async () => {
    const user = await createUser({ name: 'Bob Author' })
    const doc = await seedDoc({ ownerId: user.id })
    const created = new Date('2025-04-01T08:00:00.000Z')
    const updated = new Date('2025-04-01T09:00:00.000Z')
    await replaceCommentSnapshot(doc.docId, [
      snapshotRow({
        entryId: 'only',
        authorId: user.id,
        authorName: user.name,
        body: 'verifiable body',
        createdAt: created,
        updatedAt: updated,
        resolved: true
      })
    ])
    const thread = await getCommentThreadByEntryId(doc.docId, 'only')
    expect(thread).not.toBeNull()
    expect(thread).toHaveLength(1)
    const r = first(thread!)
    expect(r.entryId).toBe('only')
    expect(r.parentCommentId).toBeNull()
    expect(r.authorId).toBe(user.id)
    expect(r.authorName).toBe(user.name)
    expect(r.body).toBe('verifiable body')
    expect(r.resolved).toBe(true)
    expect(r.createdAt).toBeInstanceOf(Date)
    expect(r.createdAt.getTime()).toBe(created.getTime())
    expect(r.updatedAt).toBeInstanceOf(Date)
    expect(r.updatedAt.getTime()).toBe(updated.getTime())
  })

  it('cross-doc isolation: querying entryId from doc B against doc A returns null', async () => {
    // THE security-critical test. server/repos/AGENTS.md: "cross-doc isolation
    // via tuple keys — getActivityById(activityId, docId) is keyed on the
    // (id, docId) tuple — a row from doc B accessed via doc A's URL
    // returns null." Same invariant applies here: knowing an entryId on
    // doc B must not let an attacker pull it via doc A's URL.
    const user = await createUser()
    const docA = await seedDoc({ ownerId: user.id })
    const docB = await seedDoc({ ownerId: user.id })
    await replaceCommentSnapshot(docA.docId, [
      snapshotRow({ entryId: 'shared-id', body: 'A-side body' })
    ])
    await replaceCommentSnapshot(docB.docId, [
      snapshotRow({ entryId: 'shared-id', body: 'B-side body' }),
      snapshotRow({ entryId: 'b-only', body: 'b-only body' })
    ])

    // Same entryId on both docs — but the repo must scope strictly by docId.
    const fromA = await getCommentThreadByEntryId(docA.docId, 'shared-id')
    const fromB = await getCommentThreadByEntryId(docB.docId, 'shared-id')
    expect(fromA).not.toBeNull()
    expect(fromA!.map(r => r.body)).toEqual(['A-side body'])
    expect(fromB).not.toBeNull()
    expect(fromB!.map(r => r.body)).toEqual(['B-side body'])

    // Doc B's exclusive entryId is invisible from doc A's vantage point.
    expect(await getCommentThreadByEntryId(docA.docId, 'b-only')).toBeNull()
    // Both assertions in the same test are load-bearing: if the WHERE
    // dropped the docId predicate, the second call would return doc B's row.
  })

  it('cross-doc isolation: replies on doc A do not leak into doc B thread expansion', async () => {
    // Defense-in-depth: even if entryIds happen to overlap, the OR-clause
    // that fetches replies (entryId=root OR parentCommentId=root) must
    // remain doc-scoped — otherwise a reply on doc A whose parentCommentId
    // matches doc B's root id would surface in doc B's thread.
    const user = await createUser()
    const docA = await seedDoc({ ownerId: user.id })
    const docB = await seedDoc({ ownerId: user.id })
    await replaceCommentSnapshot(docA.docId, [
      snapshotRow({ entryId: 'root', body: 'A-root' }),
      snapshotRow({ entryId: 'reply-a', parentCommentId: 'root', body: 'A-reply' })
    ])
    await replaceCommentSnapshot(docB.docId, [
      // SAME root id on doc B, but with its own (different) reply.
      snapshotRow({ entryId: 'root', body: 'B-root' }),
      snapshotRow({ entryId: 'reply-b', parentCommentId: 'root', body: 'B-reply' })
    ])
    const threadB = await getCommentThreadByEntryId(docB.docId, 'root')
    expect(threadB!.map(r => r.body)).toEqual(['B-root', 'B-reply'])
    // Crucially, doc A's reply is NOT in doc B's thread.
    expect(threadB!.find(r => r.body === 'A-reply')).toBeUndefined()
  })
})
