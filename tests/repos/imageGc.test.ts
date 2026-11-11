import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { ensureYjsTable, resetDb, testDb } from '../integration/setup/db'
import { createDoc, createUser } from '../integration/setup/fixtures'
import { runImageGc } from '../../server/utils/storage/imageGc'
import { makeFakeStore, type FakeStore } from './fakeObjectStore'

// Image GC against the real DB. The property under test is SAFETY first:
// an image is only deleted when it is referenced nowhere (current doc,
// any restorable version, other docs, themes, comments) for the whole
// retention window — and the delete takes both the row and the object.

const DAY = 24 * 60 * 60 * 1000
const RETENTION_DAYS = 30

let seq = 0
let store: FakeStore

interface Image { fileId: string, s3Key: string, url: string }

async function confirmedImage(docId: string, uploaderId: number, confirmedDaysAgo = 3): Promise<Image> {
  seq++
  const fileId = `img${String(seq).padStart(9, '0')}.png`
  const s3Key = `docs/${docId}/${fileId}`
  await testDb().query(
    `INSERT INTO uploads (doc_id, file_id, uploader_id, content_type, size_bytes, s3_key, created_at, confirmed_at)
     VALUES ($1, $2, $3, 'image/png', 100, $4, now() - make_interval(days => $5), now() - make_interval(days => $5))`,
    [docId, fileId, uploaderId, s3Key, confirmedDaysAgo]
  )
  store.put(s3Key)
  return { fileId, s3Key, url: `/api/files/${docId}/${fileId}` }
}

/** Append one Y.js row per step (each step = one stored update batch). */
async function storeHistory(docId: string, steps: Array<(doc: Y.Doc) => void>): Promise<void> {
  const doc = new Y.Doc()
  for (const step of steps) {
    const before = Y.encodeStateVector(doc)
    step(doc)
    await testDb().query(
      `INSERT INTO yjs_documents (docname, value, version) VALUES ($1, $2, 'v1')`,
      [docId, Buffer.from(Y.encodeStateAsUpdate(doc, before))]
    )
  }
  doc.destroy()
}

async function compactHistory(docId: string): Promise<void> {
  const rows = await testDb().query<{ value: Buffer }>(
    `SELECT value FROM yjs_documents WHERE docname = $1 AND version = 'v1' ORDER BY id`, [docId]
  )
  const doc = new Y.Doc()
  for (const r of rows.rows) Y.applyUpdate(doc, new Uint8Array(r.value))
  const merged = Buffer.from(Y.encodeStateAsUpdate(doc))
  doc.destroy()
  await testDb().query(`DELETE FROM yjs_documents WHERE docname = $1`, [docId])
  await testDb().query(`INSERT INTO yjs_documents (docname, value, version) VALUES ($1, $2, 'v1')`, [docId, merged])
}

async function row(s3Key: string): Promise<{ unreferenced_since: Date | null, gc_checked_at: Date | null } | null> {
  const r = await testDb().query<{ unreferenced_since: Date | null, gc_checked_at: Date | null }>(
    'SELECT unreferenced_since, gc_checked_at FROM uploads WHERE s3_key = $1', [s3Key]
  )
  return r.rows[0] ?? null
}

const text = (s: string) => (d: Y.Doc) => d.getText('content').insert(d.getText('content').length, s)
const clearText = (d: Y.Doc) => {
  const t = d.getText('content')
  t.delete(0, t.length)
}

/** Two runs: one marks, one past the retention window. Returns the second run's clock. */
async function runTwice(): Promise<void> {
  const now = new Date()
  await runImageGc({ store, now, retentionDays: RETENTION_DAYS })
  await runImageGc({ store, now: new Date(now.getTime() + (RETENTION_DAYS + 1) * DAY), retentionDays: RETENTION_DAYS })
}

describe('runImageGc', () => {
  beforeAll(async () => {
    await ensureYjsTable()
  })

  beforeEach(async () => {
    await resetDb()
    store = makeFakeStore()
  })

  it('deletes an image that stayed unreferenced for the whole retention window (row + object)', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })
    const img = await confirmedImage(doc.docId, user.id)
    await storeHistory(doc.docId, [text('no images here')])

    const now = new Date()
    const first = await runImageGc({ store, now, retentionDays: RETENTION_DAYS })
    expect(first.deleted).toBe(0)
    expect((await row(img.s3Key))?.unreferenced_since).toBeInstanceOf(Date)
    expect(store.has(img.s3Key)).toBe(true)

    // Still inside the window: kept.
    await runImageGc({ store, now: new Date(now.getTime() + (RETENTION_DAYS - 1) * DAY), retentionDays: RETENTION_DAYS })
    expect(await row(img.s3Key)).not.toBeNull()

    const last = await runImageGc({ store, now: new Date(now.getTime() + (RETENTION_DAYS + 1) * DAY), retentionDays: RETENTION_DAYS })
    expect(last.deleted).toBe(1)
    expect(await row(img.s3Key)).toBeNull()
    expect(store.has(img.s3Key)).toBe(false)
  })

  it('keeps an image referenced in the current text', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })
    const img = await confirmedImage(doc.docId, user.id)
    await storeHistory(doc.docId, [text(`![a](${img.url})`)])
    await runTwice()
    expect((await row(img.s3Key))?.unreferenced_since).toBeNull()
    expect(store.has(img.s3Key)).toBe(true)
  })

  it('keeps an image only a past, still restorable version shows', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })
    const img = await confirmedImage(doc.docId, user.id)
    await storeHistory(doc.docId, [text(`![a](${img.url})`), clearText, text('rewritten')])
    await runTwice()
    expect(await row(img.s3Key)).not.toBeNull()
    expect(store.has(img.s3Key)).toBe(true)
  })

  it('deletes it once compaction has made that version unrestorable', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })
    const img = await confirmedImage(doc.docId, user.id)
    await storeHistory(doc.docId, [text(`![a](${img.url})`), clearText, text('rewritten')])
    await compactHistory(doc.docId)
    await runTwice()
    expect(await row(img.s3Key)).toBeNull()
  })

  it('keeps an image another doc references (pasted URL)', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })
    const other = await createDoc({ ownerId: user.id })
    const img = await confirmedImage(doc.docId, user.id)
    await storeHistory(doc.docId, [text('nothing')])
    await storeHistory(other.docId, [text(`see ![a](${img.url})`)])
    await runTwice()
    expect(await row(img.s3Key)).not.toBeNull()
  })

  it('keeps an image a document theme, saved theme or comment references', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })
    const inTheme = await confirmedImage(doc.docId, user.id)
    const inPreset = await confirmedImage(doc.docId, user.id)
    const inComment = await confirmedImage(doc.docId, user.id)
    await storeHistory(doc.docId, [text('nothing')])
    await testDb().query(`UPDATE documents SET theme = $1 WHERE doc_id = $2`,
      [JSON.stringify({ cover: { logoUrl: inTheme.url } }), doc.docId])
    await testDb().query(`INSERT INTO themes (theme_id, user_id, name, theme) VALUES ('t-gc', $1, 'mine', $2)`,
      [user.id, JSON.stringify({ customCss: `body { background: url(${inPreset.url}) }` })])
    await testDb().query(
      `INSERT INTO document_comments (doc_id, entry_id, author_name, body, created_at_ms, updated_at_ms)
       VALUES ($1, 'c-gc', 'U', $2, now(), now())`,
      [doc.docId, `look ![x](${inComment.url})`]
    )
    await runTwice()
    for (const img of [inTheme, inPreset, inComment]) {
      expect(await row(img.s3Key), img.fileId).not.toBeNull()
    }
  })

  it('clears the mark when the image is referenced again before the window ends', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })
    const img = await confirmedImage(doc.docId, user.id)
    await storeHistory(doc.docId, [text('nothing')])
    const now = new Date()
    await runImageGc({ store, now, retentionDays: RETENTION_DAYS })
    expect((await row(img.s3Key))?.unreferenced_since).toBeInstanceOf(Date)

    await storeHistory(doc.docId, [text(`![a](${img.url})`)])
    await runImageGc({ store, now: new Date(now.getTime() + (RETENTION_DAYS + 1) * DAY), retentionDays: RETENTION_DAYS })
    expect((await row(img.s3Key))?.unreferenced_since).toBeNull()
    expect(store.has(img.s3Key)).toBe(true)
  })

  it('never looks at freshly confirmed images, docs without stored state, or when disabled', async () => {
    const user = await createUser()
    const fresh = await createDoc({ ownerId: user.id })
    const freshImg = await confirmedImage(fresh.docId, user.id, 0)
    await storeHistory(fresh.docId, [text('nothing')])
    const stateless = await createDoc({ ownerId: user.id })
    const statelessImg = await confirmedImage(stateless.docId, user.id)

    await runImageGc({ store, retentionDays: RETENTION_DAYS })
    expect(await row(freshImg.s3Key)).toEqual({ unreferenced_since: null, gc_checked_at: null })

    await runTwice()
    expect(await row(statelessImg.s3Key)).not.toBeNull()
    expect((await row(statelessImg.s3Key))?.unreferenced_since).toBeNull()

    const disabledDoc = await createDoc({ ownerId: user.id })
    const disabledImg = await confirmedImage(disabledDoc.docId, user.id)
    await storeHistory(disabledDoc.docId, [text('nothing')])
    const res = await runImageGc({ store, retentionDays: 0 })
    expect(res.docsChecked).toBe(0)
    expect((await row(disabledImg.s3Key))?.gc_checked_at).toBeNull()
  })

  it('never touches pending (unconfirmed) uploads', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })
    await storeHistory(doc.docId, [text('nothing')])
    await testDb().query(
      `INSERT INTO uploads (doc_id, file_id, uploader_id, content_type, size_bytes, s3_key, created_at)
       VALUES ($1, 'pendingimg01.png', $2, 'image/png', 1, $3, now() - interval '40 days')`,
      [doc.docId, user.id, `docs/${doc.docId}/pendingimg01.png`]
    )
    await runTwice()
    expect(await row(`docs/${doc.docId}/pendingimg01.png`)).toEqual({ unreferenced_since: null, gc_checked_at: null })
  })
})
