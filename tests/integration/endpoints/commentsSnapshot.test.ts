import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { anonClient } from '../setup/client'
import { createDoc, createUser } from '../setup/fixtures'
import { TEST_INTERNAL_SECRET } from '../setup/env'

// POST /api/internal/comments-snapshot: sync-server → app endpoint
// that mirrors the doc's comments Y.Array into Postgres. Auth is the
// shared INTERNAL_API_SECRET header, same as activity.
//
// What we lock in:
//   - Auth: missing/wrong secret → 401, never partial writes.
//   - Validation: missing docId → 400; non-array entries → 400;
//     too many entries → 413.
//   - Doc that doesn't exist: silent no-op with mirrored:false (no
//     orphan rows for anonymous direct-URL docs).
//   - Happy path: replaces the doc's rows atomically. A second call
//     with a different list completely supersedes the first, no
//     residue from the previous snapshot.
//   - Defensive coercion: malformed entries are silently skipped,
//     valid neighbors still land. Bodies above the cap are truncated.
//   - Empty entries clear the doc's mirror.

async function countMirror(docId: string): Promise<number> {
  const db = testDb()
  const r = await db.query<{ c: string }>(
    'SELECT COUNT(*) AS c FROM document_comments WHERE doc_id = $1',
    [docId]
  )
  return Number(r.rows[0]?.c ?? 0)
}

async function readMirror(docId: string): Promise<Array<{ entry_id: string, parent_comment_id: string | null, body: string, author_id: number | null, resolved: boolean }>> {
  const db = testDb()
  const r = await db.query<{ entry_id: string, parent_comment_id: string | null, body: string, author_id: number | null, resolved: boolean }>(
    'SELECT entry_id, parent_comment_id, body, author_id, resolved FROM document_comments WHERE doc_id = $1 ORDER BY created_at_ms',
    [docId]
  )
  return r.rows
}

const secretHeaders = { 'x-internal-secret': TEST_INTERNAL_SECRET }

describe('POST /api/internal/comments-snapshot', () => {
  beforeEach(async () => {
    await resetDb()
  })

  describe('auth', () => {
    it('rejects request with no secret header (401)', async () => {
      const doc = await createDoc()
      const res = await anonClient().post('/api/internal/comments-snapshot', {
        docId: doc.docId,
        entries: []
      })
      expect(res.status).toBe(401)
    })

    it('rejects wrong secret (401)', async () => {
      const doc = await createDoc()
      const res = await anonClient().post(
        '/api/internal/comments-snapshot',
        { docId: doc.docId, entries: [] },
        { headers: { 'x-internal-secret': 'not-the-secret' } }
      )
      expect(res.status).toBe(401)
    })
  })

  describe('input validation', () => {
    it('rejects missing docId (400)', async () => {
      const res = await anonClient().post(
        '/api/internal/comments-snapshot',
        { entries: [] },
        { headers: secretHeaders }
      )
      expect(res.status).toBe(400)
    })

    it('rejects non-string docId (400)', async () => {
      const res = await anonClient().post(
        '/api/internal/comments-snapshot',
        { docId: 42, entries: [] },
        { headers: secretHeaders }
      )
      expect(res.status).toBe(400)
    })

    it('rejects entries field that is not an array (400)', async () => {
      const doc = await createDoc()
      const res = await anonClient().post(
        '/api/internal/comments-snapshot',
        { docId: doc.docId, entries: { not: 'an array' } },
        { headers: secretHeaders }
      )
      expect(res.status).toBe(400)
    })

    it('rejects entries that are not objects (400, not a 500)', async () => {
      const doc = await createDoc()
      for (const entry of [null, 'x', 5, [1]]) {
        const res = await anonClient().post(
          '/api/internal/comments-snapshot',
          { docId: doc.docId, entries: [entry] },
          { headers: secretHeaders }
        )
        expect(res.status, JSON.stringify(entry)).toBe(400)
      }
    })

    it('rejects an entries array longer than the cap (413)', async () => {
      const doc = await createDoc()
      const huge = Array.from({ length: 5001 }, (_, i) => ({
        entryId: `e${i}`, authorName: 'X', body: 'y',
        createdAt: 1, updatedAt: 1, resolved: false
      }))
      const res = await anonClient().post(
        '/api/internal/comments-snapshot',
        { docId: doc.docId, entries: huge },
        { headers: secretHeaders }
      )
      expect(res.status).toBe(413)
    })
  })

  describe('document existence', () => {
    it('skips silently when the doc has no DB row (200, mirrored:false)', async () => {
      // Anonymous direct-URL docs persist Y.js state but have no
      // documents row. We don't want orphan mirror rows for those.
      const res = await anonClient().post(
        '/api/internal/comments-snapshot',
        {
          docId: 'no-such-doc-id',
          entries: [
            { entryId: 'e1', authorName: 'X', body: 'y', createdAt: 1, updatedAt: 1, resolved: false }
          ]
        },
        { headers: secretHeaders }
      )
      expect(res.status).toBe(200)
      const body = await res.json() as { mirrored: boolean }
      expect(body.mirrored).toBe(false)
      // And no rows landed.
      expect(await countMirror('no-such-doc-id')).toBe(0)
    })
  })

  describe('happy path', () => {
    it('inserts root + reply rows with the correct parent linkage', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id })
      const now = Date.now()
      const res = await anonClient().post(
        '/api/internal/comments-snapshot',
        {
          docId: doc.docId,
          entries: [
            { entryId: 'root1', parentCommentId: null, authorId: owner.id, authorName: 'Alice', body: 'top thread', createdAt: now, updatedAt: now, resolved: false },
            { entryId: 'reply1', parentCommentId: 'root1', authorId: owner.id, authorName: 'Alice', body: 'a follow-up', createdAt: now + 1, updatedAt: now + 1, resolved: false }
          ]
        },
        { headers: secretHeaders }
      )
      expect(res.status).toBe(200)
      const body = await res.json() as { mirrored: boolean, rowCount: number }
      expect(body.mirrored).toBe(true)
      expect(body.rowCount).toBe(2)

      const rows = await readMirror(doc.docId)
      expect(rows).toEqual([
        { entry_id: 'root1', parent_comment_id: null, author_id: owner.id, body: 'top thread', resolved: false },
        { entry_id: 'reply1', parent_comment_id: 'root1', author_id: owner.id, body: 'a follow-up', resolved: false }
      ])
    })

    it('replaces the previous snapshot wholesale on the next call', async () => {
      // Atomic delete-then-insert: a second snapshot must not leave
      // residue from the first. Otherwise a deleted comment could
      // linger in the mirror forever.
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id })
      const ts = Date.now()
      await anonClient().post(
        '/api/internal/comments-snapshot',
        {
          docId: doc.docId,
          entries: [
            { entryId: 'old', authorId: owner.id, authorName: 'A', body: 'old', createdAt: ts, updatedAt: ts, resolved: false }
          ]
        },
        { headers: secretHeaders }
      )
      expect(await countMirror(doc.docId)).toBe(1)

      await anonClient().post(
        '/api/internal/comments-snapshot',
        {
          docId: doc.docId,
          entries: [
            { entryId: 'new', authorId: owner.id, authorName: 'A', body: 'new', createdAt: ts + 100, updatedAt: ts + 100, resolved: true }
          ]
        },
        { headers: secretHeaders }
      )
      const rows = await readMirror(doc.docId)
      expect(rows).toEqual([
        { entry_id: 'new', parent_comment_id: null, author_id: owner.id, body: 'new', resolved: true }
      ])
    })

    it('clears the mirror when entries is empty', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id })
      const ts = Date.now()
      await anonClient().post(
        '/api/internal/comments-snapshot',
        {
          docId: doc.docId,
          entries: [
            { entryId: 'temp', authorId: owner.id, authorName: 'A', body: 'going away', createdAt: ts, updatedAt: ts, resolved: false }
          ]
        },
        { headers: secretHeaders }
      )
      expect(await countMirror(doc.docId)).toBe(1)

      await anonClient().post(
        '/api/internal/comments-snapshot',
        { docId: doc.docId, entries: [] },
        { headers: secretHeaders }
      )
      expect(await countMirror(doc.docId)).toBe(0)
    })

    it('only touches rows for the requested docId', async () => {
      // Cross-doc safety: a snapshot for docA must not delete docB's
      // rows. The replace-by-docId scope is the whole reason the
      // primary key is composite (docId, entryId).
      const owner = await createUser()
      const docA = await createDoc({ ownerId: owner.id })
      const docB = await createDoc({ ownerId: owner.id })
      const ts = Date.now()
      const seed = (docId: string, entryId: string) => ({
        docId,
        entries: [
          { entryId, authorId: owner.id, authorName: 'A', body: 'seed', createdAt: ts, updatedAt: ts, resolved: false }
        ]
      })
      await anonClient().post('/api/internal/comments-snapshot', seed(docA.docId, 'a1'), { headers: secretHeaders })
      await anonClient().post('/api/internal/comments-snapshot', seed(docB.docId, 'b1'), { headers: secretHeaders })

      // Now snapshot docA empty, docB must remain.
      await anonClient().post(
        '/api/internal/comments-snapshot',
        { docId: docA.docId, entries: [] },
        { headers: secretHeaders }
      )
      expect(await countMirror(docA.docId)).toBe(0)
      expect(await countMirror(docB.docId)).toBe(1)
    })
  })

  describe('defensive coercion', () => {
    it('skips entries missing required fields and keeps valid neighbors', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id })
      const ts = Date.now()
      const res = await anonClient().post(
        '/api/internal/comments-snapshot',
        {
          docId: doc.docId,
          entries: [
            { entryId: 'good1', authorId: owner.id, authorName: 'A', body: 'ok', createdAt: ts, updatedAt: ts, resolved: false },
            { /* no entryId */ authorName: 'A', body: 'no id', createdAt: ts, updatedAt: ts, resolved: false },
            { entryId: 'no-name', /* authorName missing */ body: 'no name', createdAt: ts, updatedAt: ts, resolved: false },
            { entryId: 'no-body', authorName: 'A', /* body missing */ createdAt: ts, updatedAt: ts, resolved: false },
            { entryId: 'no-ts', authorName: 'A', body: 'no ts', resolved: false /* createdAt/updatedAt missing */ },
            { entryId: 'good2', authorId: owner.id, authorName: 'A', body: 'ok2', createdAt: ts + 1, updatedAt: ts + 1, resolved: false }
          ]
        },
        { headers: secretHeaders }
      )
      expect(res.status).toBe(200)
      const body = await res.json() as { rowCount: number }
      expect(body.rowCount).toBe(2)
      const rows = await readMirror(doc.docId)
      expect(rows.map(r => r.entry_id)).toEqual(['good1', 'good2'])
    })

    it('truncates oversized bodies to the server cap', async () => {
      // Defense in depth: even if a client smuggles a 50KB body
      // past the composer's maxlength, the snapshot endpoint caps
      // it before the row hits the DB. 8KB is the loosest cap with
      // headroom over the client's 4KB.
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id })
      const ts = Date.now()
      const huge = 'x'.repeat(50_000)
      await anonClient().post(
        '/api/internal/comments-snapshot',
        {
          docId: doc.docId,
          entries: [
            { entryId: 'big', authorId: owner.id, authorName: 'A', body: huge, createdAt: ts, updatedAt: ts, resolved: false }
          ]
        },
        { headers: secretHeaders }
      )
      const rows = await readMirror(doc.docId)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.body.length).toBeLessThanOrEqual(8000)
    })

    it('treats parent_comment_id as null when it is missing or empty', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id })
      const ts = Date.now()
      await anonClient().post(
        '/api/internal/comments-snapshot',
        {
          docId: doc.docId,
          entries: [
            { entryId: 'noparent', authorId: owner.id, authorName: 'A', body: 'root', createdAt: ts, updatedAt: ts, resolved: false },
            { entryId: 'emptyparent', parentCommentId: '', authorId: owner.id, authorName: 'A', body: 'also root', createdAt: ts + 1, updatedAt: ts + 1, resolved: false }
          ]
        },
        { headers: secretHeaders }
      )
      const rows = await readMirror(doc.docId)
      expect(rows.every(r => r.parent_comment_id === null)).toBe(true)
    })
  })

  describe('anonymous avatar token on activity rows', () => {
    it('stamps an anonymous author\'s token on the comment.added row, never a signed-in author\'s', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id })
      const ts = Date.now()
      const res = await anonClient().post(
        '/api/internal/comments-snapshot',
        {
          docId: doc.docId,
          entries: [
            { entryId: 'anon1', authorId: null, authorName: 'Anonymous', authorAvatarSeed: 'AnonToken1234567', body: 'hi', createdAt: ts, updatedAt: ts, resolved: false },
            { entryId: 'signed', authorId: owner.id, authorName: 'Owner', authorAvatarSeed: 'ShouldBeIgnored1', body: 'yo', createdAt: ts + 1, updatedAt: ts + 1, resolved: false },
            { entryId: 'anon2', authorId: null, authorName: 'Anonymous', authorAvatarSeed: '<script>', body: 'bad token', createdAt: ts + 2, updatedAt: ts + 2, resolved: false }
          ]
        },
        { headers: secretHeaders }
      )
      expect(res.status).toBe(200)
      const r = await testDb().query<{ commentId: string, seed: string | null }>(
        `SELECT metadata->>'commentId' AS "commentId", actor_avatar_seed AS seed
           FROM activity_log WHERE doc_id = $1 AND action = 'comment.added'`,
        [doc.docId]
      )
      const seeds = Object.fromEntries(r.rows.map(row => [row.commentId, row.seed]))
      expect(seeds).toEqual({ anon1: 'AnonToken1234567', signed: null, anon2: null })
      // The mirror table itself never stores the token.
      const cols = await testDb().query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'document_comments'`
      )
      expect(cols.rows.map(c => c.column_name)).not.toContain('author_avatar_seed')
    })
  })
})
