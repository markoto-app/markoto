import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import {
  recordPending,
  markConfirmed,
  findOwnUpload,
  confirmOwnUpload,
  deletePending,
  listStaleUnconfirmed,
  purgeStaleUnconfirmed,
  listAllS3Keys,
  deleteUploadsForDoc
} from '../../server/repos/uploads'
import { createUser, createDoc as seedDoc } from '../integration/setup/fixtures'
import { first } from '../helpers/assert'

async function rowCount(docId?: string): Promise<number> {
  const db = testDb()
  const q = docId
    ? await db.query<{ c: string }>('SELECT COUNT(*) AS c FROM uploads WHERE doc_id = $1', [docId])
    : await db.query<{ c: string }>('SELECT COUNT(*) AS c FROM uploads')
  return Number(first(q.rows).c)
}

async function setCreatedAt(s3Key: string, d: Date): Promise<void> {
  const db = testDb()
  await db.query('UPDATE uploads SET created_at = $1 WHERE s3_key = $2', [d, s3Key])
}

describe('recordPending / markConfirmed', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('inserts an unconfirmed row', async () => {
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    await recordPending({
      docId: doc.docId,
      fileId: 'abc.png',
      uploaderId: user.id,
      contentType: 'image/png',
      sizeBytes: 1000,
      s3Key: `docs/${doc.docId}/abc.png`
    })
    expect(await rowCount(doc.docId)).toBe(1)
    const db = testDb()
    const r = await db.query<{ confirmed_at: Date | null }>(
      'SELECT confirmed_at FROM uploads WHERE doc_id = $1', [doc.docId]
    )
    expect(first(r.rows).confirmed_at).toBeNull()
  })

  it('markConfirmed flips confirmed_at', async () => {
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    const key = `docs/${doc.docId}/abc.png`
    await recordPending({
      docId: doc.docId, fileId: 'abc.png', uploaderId: user.id,
      contentType: 'image/png', sizeBytes: 1, s3Key: key
    })
    await markConfirmed(key)
    const db = testDb()
    const r = await db.query<{ confirmed_at: Date | null }>(
      'SELECT confirmed_at FROM uploads WHERE s3_key = $1', [key]
    )
    expect(first(r.rows).confirmed_at).toBeInstanceOf(Date)
  })

  it('markConfirmed on an unknown key is a no-op (no error)', async () => {
    await expect(markConfirmed('docs/ghost/z.png')).resolves.toBeUndefined()
  })
})

describe('own-upload helpers (confirm path)', () => {
  beforeEach(async () => {
    await resetDb()
  })

  async function seedPending() {
    const owner = await createUser()
    const other = await createUser()
    const doc = await seedDoc({ ownerId: owner.id })
    const key = `docs/${doc.docId}/abc.png`
    await recordPending({
      docId: doc.docId, fileId: 'abc.png', uploaderId: owner.id,
      contentType: 'image/png', sizeBytes: 7, s3Key: key
    })
    return { owner, other, doc, key }
  }

  it('findOwnUpload only resolves for the uploader', async () => {
    const { owner, other, doc, key } = await seedPending()
    expect(await findOwnUpload(key, other.id)).toBeNull()
    expect(await findOwnUpload('docs/nope/x.png', owner.id)).toBeNull()
    const row = await findOwnUpload(key, owner.id)
    expect(row).toMatchObject({ docId: doc.docId, sizeBytes: 7, confirmedAt: null })
  })

  it('confirmOwnUpload flips once and refuses other users', async () => {
    const { owner, other, key } = await seedPending()
    expect(await confirmOwnUpload(key, other.id)).toBe(false)
    expect(await confirmOwnUpload(key, owner.id)).toBe(true)
    expect(await confirmOwnUpload(key, owner.id)).toBe(false)
    expect((await findOwnUpload(key, owner.id))?.confirmedAt).toBeInstanceOf(Date)
  })

  it('deletePending removes only the uploader\'s pending row', async () => {
    const { owner, other, key } = await seedPending()
    await deletePending(key, other.id)
    expect(await findOwnUpload(key, owner.id)).not.toBeNull()
    await confirmOwnUpload(key, owner.id)
    await deletePending(key, owner.id)
    expect(await findOwnUpload(key, owner.id)).not.toBeNull()
  })

  it('deletePending drops a still-pending row', async () => {
    const { owner, key } = await seedPending()
    await deletePending(key, owner.id)
    expect(await findOwnUpload(key, owner.id)).toBeNull()
  })
})

describe('listStaleUnconfirmed / purgeStaleUnconfirmed', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns only unconfirmed AND older than the cutoff', async () => {
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    // row A: old + unconfirmed → stale
    await recordPending({ docId: doc.docId, fileId: 'a.png', uploaderId: user.id, contentType: 'image/png', sizeBytes: 1, s3Key: 'k-a' })
    await setCreatedAt('k-a', new Date(Date.now() - 48 * 60 * 60 * 1000))
    // row B: old + confirmed → not stale (still in use)
    await recordPending({ docId: doc.docId, fileId: 'b.png', uploaderId: user.id, contentType: 'image/png', sizeBytes: 1, s3Key: 'k-b' })
    await setCreatedAt('k-b', new Date(Date.now() - 48 * 60 * 60 * 1000))
    await markConfirmed('k-b')
    // row C: fresh + unconfirmed → still inside the grace window
    await recordPending({ docId: doc.docId, fileId: 'c.png', uploaderId: user.id, contentType: 'image/png', sizeBytes: 1, s3Key: 'k-c' })

    const stale = await listStaleUnconfirmed(24 * 60 * 60 * 1000)
    expect(stale.map(s => s.s3Key)).toEqual(['k-a'])
  })

  it('purgeStaleUnconfirmed deletes only the stale unconfirmed rows', async () => {
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    // Stale unconfirmed.
    await recordPending({ docId: doc.docId, fileId: 's.png', uploaderId: user.id, contentType: 'image/png', sizeBytes: 1, s3Key: 'k-stale' })
    await setCreatedAt('k-stale', new Date(Date.now() - 48 * 60 * 60 * 1000))
    // Stale confirmed — must NOT be touched.
    await recordPending({ docId: doc.docId, fileId: 'f.png', uploaderId: user.id, contentType: 'image/png', sizeBytes: 1, s3Key: 'k-old-confirmed' })
    await setCreatedAt('k-old-confirmed', new Date(Date.now() - 48 * 60 * 60 * 1000))
    await markConfirmed('k-old-confirmed')

    await purgeStaleUnconfirmed(24 * 60 * 60 * 1000)
    expect(await rowCount(doc.docId)).toBe(1)
    const db = testDb()
    const r = await db.query<{ s3_key: string }>('SELECT s3_key FROM uploads')
    expect(first(r.rows).s3_key).toBe('k-old-confirmed')
  })
})

describe('listAllS3Keys', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns every s3Key regardless of confirmed state', async () => {
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    await recordPending({ docId: doc.docId, fileId: 'a.png', uploaderId: user.id, contentType: 'image/png', sizeBytes: 1, s3Key: 'k-a' })
    await recordPending({ docId: doc.docId, fileId: 'b.png', uploaderId: user.id, contentType: 'image/png', sizeBytes: 1, s3Key: 'k-b' })
    await markConfirmed('k-b')
    const keys = (await listAllS3Keys()).sort()
    expect(keys).toEqual(['k-a', 'k-b'])
  })
})

describe('deleteUploadsForDoc', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('removes every upload row for that doc, leaves others alone', async () => {
    const user = await createUser()
    const docA = await seedDoc({ ownerId: user.id })
    const docB = await seedDoc({ ownerId: user.id })
    await recordPending({ docId: docA.docId, fileId: 'a.png', uploaderId: user.id, contentType: 'image/png', sizeBytes: 1, s3Key: 'ka' })
    await recordPending({ docId: docB.docId, fileId: 'b.png', uploaderId: user.id, contentType: 'image/png', sizeBytes: 1, s3Key: 'kb' })
    await deleteUploadsForDoc(docA.docId)
    expect(await rowCount(docA.docId)).toBe(0)
    expect(await rowCount(docB.docId)).toBe(1)
  })
})
