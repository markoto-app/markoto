import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'

// Unit tests for cloneYjsStateWithUrlRewrite. The DB layer is a thin
// pull-then-insert around a pure Y.Doc transformation; we stub the pool
// at the module boundary and assert both the rewrite correctness and
// the shape of what gets inserted.
//
// The rewrite is security-relevant: a miss here silently leaves the
// duplicate pointing at `/api/files/{sourceDocId}/…` paths. That's
// not a read-security problem today (the endpoint gates on docId-in-URL,
// so a duplicate member who isn't a source member would get 403s on
// every image) but it IS a correctness problem — the duplicate looks
// broken, and deleting the source would kill the duplicate's images.

const mockQuery = vi.fn()
vi.mock('../../server/utils/database', () => ({
  useDatabasePool: () => ({ query: mockQuery })
}))

const { cloneYjsStateWithUrlRewrite } = await import('../../server/utils/cloneYjsState')

/**
 * Build a y-postgresql-shaped {value: Buffer} row from a Y.Doc by
 * encoding the whole state as a single update. Good enough for replay
 * tests — y-postgresql would normally store many smaller updates, but
 * `Y.applyUpdate` over `[encodeStateAsUpdate(doc)]` produces the same
 * final state as over the real update log, and we're testing the
 * replay + rewrite, not the incremental-update semantics.
 */
function rowFromDoc(doc: Y.Doc): { value: Buffer } {
  return { value: Buffer.from(Y.encodeStateAsUpdate(doc)) }
}

/**
 * Reconstruct a Y.Doc from the single-row update buffer the SUT
 * inserts, so tests can assert on text + meta.
 */
function docFromInsertedUpdate(insertCall: [string, unknown[]]): Y.Doc {
  const params = insertCall[1] as [string, Buffer, string]
  const buf = params[1]
  const doc = new Y.Doc()
  Y.applyUpdate(doc, new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
  return doc
}

beforeEach(() => {
  mockQuery.mockReset()
})

describe('cloneYjsStateWithUrlRewrite — empty source', () => {
  it('no-ops when the source has no rows (never opened / persisted)', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] })
    await cloneYjsStateWithUrlRewrite('src', 'tgt')
    // Only the SELECT — no INSERT follows.
    expect(mockQuery).toHaveBeenCalledTimes(1)
    expect(mockQuery.mock.calls[0][0]).toMatch(/SELECT value FROM yjs_documents/i)
  })
})

describe('cloneYjsStateWithUrlRewrite — URL rewrite', () => {
  it('rewrites every occurrence of /api/files/{src}/ to /api/files/{tgt}/', async () => {
    const src = new Y.Doc()
    src.getText('content').insert(0, 'See ![](/api/files/SRC/a.png) and ![](/api/files/SRC/b.png)')
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [rowFromDoc(src)] })
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] })

    await cloneYjsStateWithUrlRewrite('SRC', 'TGT')

    expect(mockQuery).toHaveBeenCalledTimes(2)
    const tgt = docFromInsertedUpdate(mockQuery.mock.calls[1] as [string, unknown[]])
    expect(tgt.getText('content').toString()).toBe(
      'See ![](/api/files/TGT/a.png) and ![](/api/files/TGT/b.png)'
    )
  })

  it('only touches the exact prefix — no accidental match on a similar path', async () => {
    // `/api/files/SRCX/…` (different docId starting with SRC) must NOT
    // be rewritten. The trailing slash in the replacement anchors the
    // match to the full docId.
    const src = new Y.Doc()
    src.getText('content').insert(0, '![](/api/files/SRCX/img.png) and ![](/api/files/SRC/img.png)')
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [rowFromDoc(src)] })
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] })

    await cloneYjsStateWithUrlRewrite('SRC', 'TGT')

    const tgt = docFromInsertedUpdate(mockQuery.mock.calls[1] as [string, unknown[]])
    expect(tgt.getText('content').toString()).toBe(
      '![](/api/files/SRCX/img.png) and ![](/api/files/TGT/img.png)'
    )
  })

  it('preserves external http(s) image URLs verbatim', async () => {
    // External image references must NOT be touched. A homepage doc
    // embeds `https://example.com/logo.png` all the time.
    const src = new Y.Doc()
    src.getText('content').insert(0, '![](https://example.com/logo.png)\n![](/api/files/SRC/local.png)')
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [rowFromDoc(src)] })
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] })

    await cloneYjsStateWithUrlRewrite('SRC', 'TGT')

    const tgt = docFromInsertedUpdate(mockQuery.mock.calls[1] as [string, unknown[]])
    expect(tgt.getText('content').toString()).toBe(
      '![](https://example.com/logo.png)\n![](/api/files/TGT/local.png)'
    )
  })

  it('handles text with zero image references (rewrite is a no-op substring search)', async () => {
    const src = new Y.Doc()
    src.getText('content').insert(0, '# Just a heading\n\nSome body text. No images here.')
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [rowFromDoc(src)] })
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] })

    await cloneYjsStateWithUrlRewrite('SRC', 'TGT')

    const tgt = docFromInsertedUpdate(mockQuery.mock.calls[1] as [string, unknown[]])
    expect(tgt.getText('content').toString()).toBe('# Just a heading\n\nSome body text. No images here.')
  })

  it('handles an empty source doc (persisted but empty)', async () => {
    // A freshly-created doc that got persisted with no content yet.
    // Should still insert a row so the target has an initialized shape.
    const src = new Y.Doc()
    // Touch the text + meta structures so encodeStateAsUpdate emits
    // non-empty bytes, simulating a persisted-but-empty doc.
    src.getText('content')
    src.getMap('meta')
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [rowFromDoc(src)] })
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] })

    await cloneYjsStateWithUrlRewrite('SRC', 'TGT')

    const tgt = docFromInsertedUpdate(mockQuery.mock.calls[1] as [string, unknown[]])
    expect(tgt.getText('content').toString()).toBe('')
  })
})

describe('cloneYjsStateWithUrlRewrite — ymeta carry-over', () => {
  it('copies title, theme, and other ymeta entries to the target', async () => {
    const src = new Y.Doc()
    src.getText('content').insert(0, 'body')
    const meta = src.getMap('meta')
    meta.set('title', 'Source Title')
    meta.set('theme', { page: { marginMm: 25 } })
    meta.set('custom', 42)
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [rowFromDoc(src)] })
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] })

    await cloneYjsStateWithUrlRewrite('SRC', 'TGT')

    const tgt = docFromInsertedUpdate(mockQuery.mock.calls[1] as [string, unknown[]])
    const tgtMeta = tgt.getMap('meta')
    expect(tgtMeta.get('title')).toBe('Source Title')
    expect(tgtMeta.get('theme')).toEqual({ page: { marginMm: 25 } })
    expect(tgtMeta.get('custom')).toBe(42)
  })

  it('drops the `_deleted` flag (transient session state must NOT leak)', async () => {
    // If the source was concurrently being deleted when the clone ran,
    // its ymeta could carry `_deleted: true`. The duplicate must start
    // fresh — otherwise opening it would immediately show "this doc
    // was deleted" and confuse the user.
    const src = new Y.Doc()
    src.getText('content').insert(0, 'body')
    const meta = src.getMap('meta')
    meta.set('title', 'Source Title')
    meta.set('_deleted', true)
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [rowFromDoc(src)] })
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] })

    await cloneYjsStateWithUrlRewrite('SRC', 'TGT')

    const tgt = docFromInsertedUpdate(mockQuery.mock.calls[1] as [string, unknown[]])
    const tgtMeta = tgt.getMap('meta')
    expect(tgtMeta.get('title')).toBe('Source Title')
    expect(tgtMeta.get('_deleted')).toBeUndefined()
  })
})

describe('cloneYjsStateWithUrlRewrite — multi-update replay', () => {
  it('applies every stored update in id-order (simulates a real update log)', async () => {
    // Real y-postgresql stores many small updates per doc. The SUT
    // must replay them in order before doing the rewrite — otherwise
    // the reconstructed doc is missing late writes.
    const intermediate = new Y.Doc()
    intermediate.getText('content').insert(0, 'hello ')
    const update1 = Y.encodeStateAsUpdate(intermediate)

    intermediate.getText('content').insert(6, '![](/api/files/SRC/pic.png)')
    // update2 = diff between intermediate (step 1) and final
    const update2 = Y.encodeStateAsUpdate(intermediate)

    mockQuery.mockResolvedValueOnce({
      rowCount: 2,
      rows: [{ value: Buffer.from(update1) }, { value: Buffer.from(update2) }]
    })
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] })

    await cloneYjsStateWithUrlRewrite('SRC', 'TGT')

    const tgt = docFromInsertedUpdate(mockQuery.mock.calls[1] as [string, unknown[]])
    expect(tgt.getText('content').toString()).toBe('hello ![](/api/files/TGT/pic.png)')
  })
})

describe('cloneYjsStateWithUrlRewrite — INSERT shape', () => {
  it('inserts under the target docname with version=v1', async () => {
    const src = new Y.Doc()
    src.getText('content').insert(0, 'x')
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [rowFromDoc(src)] })
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] })

    await cloneYjsStateWithUrlRewrite('SRC', 'TGT')

    const [sql, params] = mockQuery.mock.calls[1] as [string, unknown[]]
    expect(sql).toMatch(/INSERT INTO yjs_documents/i)
    expect(sql).toMatch(/version/i)
    // Params: [docname, value, version] — the SUT pins version to v1
    // in the SQL itself, so we only check docname + value here.
    expect(params[0]).toBe('TGT')
    expect(params[1]).toBeInstanceOf(Buffer)
    expect((params[1] as Buffer).byteLength).toBeGreaterThan(0)
  })
})
