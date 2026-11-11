import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import {
  recordPending,
  markConfirmed,
  listConfirmedUploadsForDoc,
  insertConfirmedUploads
} from '../../server/repos/uploads'
import { createUser, createDoc as seedDoc } from '../integration/setup/fixtures'
import { first } from '../helpers/assert'

// Repo-level tests for the new helpers used by the duplicate flow.
// `listConfirmedUploadsForDoc` and `insertConfirmedUploads` feed the
// S3 CopyObject loop in duplicateDocument — wrong behaviour here =
// dupe either misses images or inserts bogus rows.

async function rowCount(docId: string): Promise<number> {
  const db = testDb()
  const r = await db.query<{ c: string }>(
    'SELECT COUNT(*) AS c FROM uploads WHERE doc_id = $1',
    [docId]
  )
  return Number(first(r.rows).c)
}

describe('listConfirmedUploadsForDoc', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns only confirmed uploads for the requested doc', async () => {
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    // One confirmed, one pending — only the confirmed one should land in
    // the clone set. Pending rows may not even have an S3 object yet, so
    // copying them would error inside CopyObject.
    await recordPending({
      docId: doc.docId,
      fileId: 'a.png',
      uploaderId: user.id,
      contentType: 'image/png',
      sizeBytes: 100,
      s3Key: `docs/${doc.docId}/a.png`
    })
    await markConfirmed(`docs/${doc.docId}/a.png`)
    await recordPending({
      docId: doc.docId,
      fileId: 'b.png',
      uploaderId: user.id,
      contentType: 'image/png',
      sizeBytes: 200,
      s3Key: `docs/${doc.docId}/b.png`
    })
    // b.png intentionally left unconfirmed.

    const rows = await listConfirmedUploadsForDoc(doc.docId)
    expect(rows).toHaveLength(1)
    expect(first(rows).fileId).toBe('a.png')
    expect(first(rows).contentType).toBe('image/png')
    expect(first(rows).sizeBytes).toBe(100)
    expect(first(rows).uploaderId).toBe(user.id)
    expect(first(rows).s3Key).toBe(`docs/${doc.docId}/a.png`)
  })

  it('scopes to the requested doc (no cross-doc leakage)', async () => {
    const user = await createUser()
    const mine = await seedDoc({ ownerId: user.id })
    const other = await seedDoc({ ownerId: user.id })
    await recordPending({
      docId: mine.docId,
      fileId: 'm.png',
      uploaderId: user.id,
      contentType: 'image/png',
      sizeBytes: 1,
      s3Key: `docs/${mine.docId}/m.png`
    })
    await markConfirmed(`docs/${mine.docId}/m.png`)
    await recordPending({
      docId: other.docId,
      fileId: 'o.png',
      uploaderId: user.id,
      contentType: 'image/png',
      sizeBytes: 1,
      s3Key: `docs/${other.docId}/o.png`
    })
    await markConfirmed(`docs/${other.docId}/o.png`)

    const rows = await listConfirmedUploadsForDoc(mine.docId)
    expect(rows.map(r => r.fileId)).toEqual(['m.png'])
  })

  it('returns [] for a doc with no uploads', async () => {
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    expect(await listConfirmedUploadsForDoc(doc.docId)).toEqual([])
  })
})

describe('insertConfirmedUploads', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('bulk-inserts rows with confirmedAt auto-populated', async () => {
    const user = await createUser()
    const target = await seedDoc({ ownerId: user.id })

    await insertConfirmedUploads([
      {
        docId: target.docId,
        fileId: 'a.png',
        uploaderId: user.id,
        contentType: 'image/png',
        sizeBytes: 100,
        s3Key: `docs/${target.docId}/a.png`
      },
      {
        docId: target.docId,
        fileId: 'b.png',
        uploaderId: user.id,
        contentType: 'image/jpeg',
        sizeBytes: 200,
        s3Key: `docs/${target.docId}/b.png`
      }
    ])

    expect(await rowCount(target.docId)).toBe(2)
    // Both rows must be confirmed — the duplicate flow skips them
    // otherwise (listConfirmedUploadsForDoc filters on confirmedAt NOT
    // NULL) so a future move/dupe of the dupe would see an empty set.
    const rows = await listConfirmedUploadsForDoc(target.docId)
    expect(rows.map(r => r.fileId).sort()).toEqual(['a.png', 'b.png'])
    // Content type preserved per-row (not flattened to a single value).
    const byFile = new Map(rows.map(r => [r.fileId, r]))
    expect(byFile.get('a.png')!.contentType).toBe('image/png')
    expect(byFile.get('b.png')!.contentType).toBe('image/jpeg')
  })

  it('handles empty input as a no-op (no SQL fired on [])', async () => {
    // drizzle's insert().values([]) blows up with a PG syntax error if
    // the helper doesn't short-circuit first. The early return in the
    // helper guards against that. Pin the behaviour so a refactor
    // doesn't reintroduce the crash.
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    await expect(insertConfirmedUploads([])).resolves.toBeUndefined()
    expect(await rowCount(doc.docId)).toBe(0)
  })

  it('accepts a null uploaderId (anon-owned source that had anon uploads)', async () => {
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    await insertConfirmedUploads([{
      docId: doc.docId,
      fileId: 'anon.png',
      uploaderId: null,
      contentType: 'image/png',
      sizeBytes: 1,
      s3Key: `docs/${doc.docId}/anon.png`
    }])
    const rows = await listConfirmedUploadsForDoc(doc.docId)
    expect(first(rows).uploaderId).toBeNull()
  })
})
