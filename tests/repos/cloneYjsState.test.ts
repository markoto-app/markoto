import { describe, it, expect, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { resetDb, testDb } from '../integration/setup/db'
import { cloneYjsStateWithUrlRewrite } from '../../server/utils/documents/cloneYjsState'
import { first } from '../helpers/assert'

// `cloneYjsStateWithUrlRewrite` reads the source doc's stored Y.js
// state, reconstructs a Y.Doc, rewrites `/api/files/{sourceDocId}/`
// image URLs to the target's docId, and writes a single update row
// for the target. Rows reference `documents`, so every doc id used
// here gets a documents row first (`ensureDoc`).

async function ensureDoc(docId: string): Promise<void> {
  await testDb().query('INSERT INTO documents (doc_id) VALUES ($1) ON CONFLICT DO NOTHING', [docId])
}

async function clone(source: string, target: string): Promise<void> {
  await ensureDoc(source)
  await ensureDoc(target)
  await cloneYjsStateWithUrlRewrite(source, target)
}

async function countRows(docname: string): Promise<number> {
  const db = testDb()
  const r = await db.query<{ c: string }>(
    `SELECT COUNT(*) AS c FROM yjs_updates WHERE doc_id = $1`,
    [docname]
  )
  return Number(first(r.rows).c)
}

async function fetchTargetDoc(docname: string): Promise<Y.Doc> {
  // The clone writes a SINGLE update row, so replaying all rows gives
  // us the reconstructed target doc. If we ever switch to multi-row
  // output this still works (applyUpdate is additive).
  const db = testDb()
  const r = await db.query<{ value: Buffer }>(
    `SELECT data AS value FROM yjs_updates WHERE doc_id = $1 ORDER BY id`,
    [docname]
  )
  const doc = new Y.Doc()
  for (const row of r.rows) {
    Y.applyUpdate(doc, new Uint8Array(row.value.buffer, row.value.byteOffset, row.value.byteLength))
  }
  return doc
}

async function seedSource(docname: string, build: (doc: Y.Doc) => void): Promise<void> {
  const src = new Y.Doc()
  build(src)
  const update = Buffer.from(Y.encodeStateAsUpdate(src))
  await ensureDoc(docname)
  await testDb().query(
    `INSERT INTO yjs_updates (doc_id, kind, data) VALUES ($1, 'update', $2)`,
    [docname, update]
  )
}

describe('cloneYjsStateWithUrlRewrite', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('no-ops when the source has no rows (duplicate of an un-synced doc)', async () => {
    // A doc created via POST /api/docs but never opened has zero
    // yjs_updates rows. The duplicate should leave the target empty
    // so the next client that opens it gets the usual "empty Y.Doc +
    // DB seed" path.
    await clone('source', 'target')
    expect(await countRows('target')).toBe(0)
  })

  it('clones text content verbatim when no image URLs are present', async () => {
    await seedSource('source', (doc) => {
      doc.getText('content').insert(0, '# Hello world\n\nSome body text.')
    })

    await clone('source', 'target')

    expect(await countRows('target')).toBe(1)
    const cloned = await fetchTargetDoc('target')
    expect(cloned.getText('content').toString()).toBe('# Hello world\n\nSome body text.')
  })

  it('rewrites /api/files/{sourceDocId}/ → /api/files/{targetDocId}/ in the content', async () => {
    // The core invariant: a duplicated doc must reference ITS OWN
    // file paths so (a) the /api/files authz gate resolves against the
    // duplicate's access mode, not the source's, and (b) deleting the
    // source doesn't 404 the duplicate's images.
    await seedSource('source-doc-id', (doc) => {
      doc.getText('content').insert(0,
        'Before ![a](/api/files/source-doc-id/a.png) and '
        + '![b](/api/files/source-doc-id/b.jpg) after'
      )
    })

    await clone('source-doc-id', 'target-doc-id')

    const cloned = await fetchTargetDoc('target-doc-id')
    const text = cloned.getText('content').toString()
    expect(text).toContain('/api/files/target-doc-id/a.png')
    expect(text).toContain('/api/files/target-doc-id/b.jpg')
    expect(text).not.toContain('/api/files/source-doc-id/')
  })

  it('does NOT rewrite URLs that merely contain the source docId as a substring', async () => {
    // Regression guard: the rewrite must be anchored to the
    // `/api/files/{docId}/` prefix. If someone writes the literal
    // source docId in prose or links to a URL that happens to contain
    // it, those should survive untouched.
    await seedSource('abc', (doc) => {
      doc.getText('content').insert(0,
        'My docId is abc. Unrelated link: https://example.com/abc/xyz '
        + 'But this one gets rewritten: /api/files/abc/pic.png'
      )
    })

    await clone('abc', 'xyz')

    const cloned = await fetchTargetDoc('xyz')
    const text = cloned.getText('content').toString()
    expect(text).toContain('My docId is abc.') // prose untouched
    expect(text).toContain('https://example.com/abc/xyz') // unrelated URL untouched
    expect(text).toContain('/api/files/xyz/pic.png') // the real image URL rewritten
  })

  it('copies ymeta fields (title, theme) but drops _deleted', async () => {
    // The source might be currently flagged as deleted (e.g. an
    // in-flight deletion on a connected client). The duplicate must
    // NOT inherit that flag — otherwise the clone would appear to
    // vanish on the first Y.js sync.
    await seedSource('src', (doc) => {
      const meta = doc.getMap('meta')
      meta.set('title', 'Source Title')
      meta.set('theme', { foo: 'bar' })
      meta.set('_deleted', true)
    })

    await clone('src', 'tgt')

    const cloned = await fetchTargetDoc('tgt')
    const meta = cloned.getMap('meta')
    expect(meta.get('title')).toBe('Source Title')
    expect(meta.get('theme')).toEqual({ foo: 'bar' })
    expect(meta.get('_deleted')).toBeUndefined()
  })

  it('handles a source with many incremental updates (merges to a single target row)', async () => {
    // The sync server appends one row per store, so a real doc has many
    // rows. The clone replays all of them and emits a single update.
    const db = testDb()
    await ensureDoc('multi-src')
    const srcDoc = new Y.Doc()
    // Build in chunks so each storeUpdate is a separate row. We use
    // manual inserts because Y.encodeStateAsUpdate(srcDoc) after each
    // insert is the simplest way to emit distinct update blobs.
    srcDoc.getText('content').insert(0, 'First. ')
    let update = Buffer.from(Y.encodeStateAsUpdate(srcDoc))
    await db.query(
      `INSERT INTO yjs_updates (doc_id, kind, data) VALUES ('multi-src', 'update', $1)`,
      [update]
    )
    // Diff-then-append via encodeStateAsUpdate would be cheaper, but a
    // full-state write per tick is sufficient for the test — the clone
    // replays them in id order regardless.
    srcDoc.getText('content').insert(srcDoc.getText('content').length, 'Second. ')
    update = Buffer.from(Y.encodeStateAsUpdate(srcDoc))
    await db.query(
      `INSERT INTO yjs_updates (doc_id, kind, data) VALUES ('multi-src', 'update', $1)`,
      [update]
    )
    srcDoc.getText('content').insert(srcDoc.getText('content').length, 'Third.')
    update = Buffer.from(Y.encodeStateAsUpdate(srcDoc))
    await db.query(
      `INSERT INTO yjs_updates (doc_id, kind, data) VALUES ('multi-src', 'update', $1)`,
      [update]
    )

    await clone('multi-src', 'multi-tgt')

    // One row on the target: the clone compacts everything into a
    // single `Y.encodeStateAsUpdate` output.
    expect(await countRows('multi-tgt')).toBe(1)
    const cloned = await fetchTargetDoc('multi-tgt')
    expect(cloned.getText('content').toString()).toBe('First. Second. Third.')
  })

  it('does not touch the source rows', async () => {
    await seedSource('src', (doc) => {
      doc.getText('content').insert(0, 'original')
    })

    await clone('src', 'tgt')

    const srcCount = await countRows('src')
    expect(srcCount).toBe(1)
    // And the source doc still has its original text.
    const srcDoc = await fetchTargetDoc('src')
    expect(srcDoc.getText('content').toString()).toBe('original')
  })

  it('starts from the newest snapshot and never reads the rows below it', async () => {
    await ensureDoc('src')
    const src = new Y.Doc()
    src.getText('content').insert(0, 'snapshot content')
    const db = testDb()
    // An undecodable row below the snapshot: replaying it would throw, so
    // the clone passing proves it starts at the snapshot.
    await db.query(`INSERT INTO yjs_updates (doc_id, kind, data) VALUES ('src', 'update', $1)`, [Buffer.from([0xff, 0xff])])
    await db.query(`INSERT INTO yjs_updates (doc_id, kind, data) VALUES ('src', 'snapshot', $1)`, [Buffer.from(Y.encodeStateAsUpdate(src))])
    const before = Y.encodeStateVector(src)
    src.getText('content').insert(src.getText('content').length, ' + later edit')
    await db.query(`INSERT INTO yjs_updates (doc_id, kind, data) VALUES ('src', 'update', $1)`, [Buffer.from(Y.encodeStateAsUpdate(src, before))])

    await expect(clone('src', 'tgt')).resolves.toBeUndefined()
    const cloned = await fetchTargetDoc('tgt')
    expect(cloned.getText('content').toString()).toBe('snapshot content + later edit')
  })
})
