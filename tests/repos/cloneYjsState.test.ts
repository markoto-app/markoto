import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { ensureYjsTable, resetDb, testDb } from '../integration/setup/db'
import { cloneYjsStateWithUrlRewrite } from '../../server/utils/documents/cloneYjsState'

// `cloneYjsStateWithUrlRewrite` reads the source doc's stored Y.js
// updates, reconstructs a Y.Doc, rewrites `/api/files/{sourceDocId}/`
// image URLs to the target's docId, and writes a single compacted
// update under the target docname. The sync-server owns the
// `yjs_documents` table at runtime, but the schema is stable — the
// shared `ensureYjsTable` helper recreates the same schema so this
// test can seed inputs without booting Hocuspocus.

async function countRows(docname: string): Promise<number> {
  const db = testDb()
  const r = await db.query<{ c: string }>(
    `SELECT COUNT(*) AS c FROM yjs_documents WHERE docname = $1`,
    [docname]
  )
  return Number(r.rows[0].c)
}

async function fetchTargetDoc(docname: string): Promise<Y.Doc> {
  // The clone writes a SINGLE update row, so replaying all rows gives
  // us the reconstructed target doc. If we ever switch to multi-row
  // output this still works (applyUpdate is additive).
  const db = testDb()
  const r = await db.query<{ value: Buffer }>(
    `SELECT value FROM yjs_documents WHERE docname = $1 AND version = 'v1' ORDER BY id`,
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
  const db = testDb()
  await db.query(
    `INSERT INTO yjs_documents (docname, value, version) VALUES ($1, $2, 'v1')`,
    [docname, update]
  )
}

describe('cloneYjsStateWithUrlRewrite', () => {
  beforeAll(async () => {
    await ensureYjsTable()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('no-ops when the source has no rows (duplicate of an un-synced doc)', async () => {
    // A doc created via POST /api/docs but never opened has zero
    // yjs_documents rows. The duplicate should leave the target empty
    // so the next client that opens it gets the usual "empty Y.Doc +
    // DB seed" path.
    await cloneYjsStateWithUrlRewrite('source', 'target')
    expect(await countRows('target')).toBe(0)
  })

  it('clones text content verbatim when no image URLs are present', async () => {
    await seedSource('source', (doc) => {
      doc.getText('content').insert(0, '# Hello world\n\nSome body text.')
    })

    await cloneYjsStateWithUrlRewrite('source', 'target')

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

    await cloneYjsStateWithUrlRewrite('source-doc-id', 'target-doc-id')

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

    await cloneYjsStateWithUrlRewrite('abc', 'xyz')

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

    await cloneYjsStateWithUrlRewrite('src', 'tgt')

    const cloned = await fetchTargetDoc('tgt')
    const meta = cloned.getMap('meta')
    expect(meta.get('title')).toBe('Source Title')
    expect(meta.get('theme')).toEqual({ foo: 'bar' })
    expect(meta.get('_deleted')).toBeUndefined()
  })

  it('handles a source with many incremental updates (merges to a single target row)', async () => {
    // y-postgresql writes one row per `storeUpdate`, so a real doc has
    // many rows per docname (merged in place by flushSize). The clone
    // replays all of them and emits a single compacted update.
    const db = testDb()
    const srcDoc = new Y.Doc()
    // Build in chunks so each storeUpdate is a separate row. We use
    // manual inserts because Y.encodeStateAsUpdate(srcDoc) after each
    // insert is the simplest way to emit distinct update blobs.
    srcDoc.getText('content').insert(0, 'First. ')
    let update = Buffer.from(Y.encodeStateAsUpdate(srcDoc))
    await db.query(
      `INSERT INTO yjs_documents (docname, value, version) VALUES ('multi-src', $1, 'v1')`,
      [update]
    )
    // Diff-then-append via encodeStateAsUpdate would be cheaper, but a
    // full-state write per tick is sufficient for the test — the clone
    // replays them in id order regardless.
    srcDoc.getText('content').insert(srcDoc.getText('content').length, 'Second. ')
    update = Buffer.from(Y.encodeStateAsUpdate(srcDoc))
    await db.query(
      `INSERT INTO yjs_documents (docname, value, version) VALUES ('multi-src', $1, 'v1')`,
      [update]
    )
    srcDoc.getText('content').insert(srcDoc.getText('content').length, 'Third.')
    update = Buffer.from(Y.encodeStateAsUpdate(srcDoc))
    await db.query(
      `INSERT INTO yjs_documents (docname, value, version) VALUES ('multi-src', $1, 'v1')`,
      [update]
    )

    await cloneYjsStateWithUrlRewrite('multi-src', 'multi-tgt')

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

    await cloneYjsStateWithUrlRewrite('src', 'tgt')

    const srcCount = await countRows('src')
    expect(srcCount).toBe(1)
    // And the source doc still has its original text.
    const srcDoc = await fetchTargetDoc('src')
    expect(srcDoc.getText('content').toString()).toBe('original')
  })

  it('ignores v1_sv rows (only v1 updates are replayed)', async () => {
    // y-postgresql tracks a state-vector snapshot as a v1_sv row to
    // speed up incremental loads. Those blobs are NOT applicable as
    // updates and must not be replayed by the clone. If a future
    // refactor accidentally SELECTs all versions, Y.applyUpdate would
    // throw on the state-vector bytes.
    await seedSource('src', (doc) => {
      doc.getText('content').insert(0, 'real content')
    })
    const db = testDb()
    // Inject a bogus v1_sv row — real state vectors are smaller, but
    // the exact shape doesn't matter for this test. The helper should
    // skip the row by filtering on `version = 'v1'`.
    await db.query(
      `INSERT INTO yjs_documents (docname, value, version) VALUES ('src', $1, 'v1_sv')`,
      [Buffer.from([0xff, 0xff])]
    )

    await expect(cloneYjsStateWithUrlRewrite('src', 'tgt')).resolves.toBeUndefined()
    const cloned = await fetchTargetDoc('tgt')
    expect(cloned.getText('content').toString()).toBe('real content')
  })
})
