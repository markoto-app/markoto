import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'

// cloneYjsState unit-level complement. The comprehensive coverage lives
// in `tests/repos/cloneYjsState.test.ts` which exercises the real DB.
// This file keeps only the cases that unit-level mocking adds value for
// (or that the repo test doesn't cover):
//
//   - External URL preservation (not in repo test)
//   - SRCX vs SRC substring-vs-full-match (critical security boundary,
//     easy for a refactor to break if someone replaces `replaceAll`
//     with a regex)
//
// Everything else was redundant with the repo test and has been deleted.
// Coverage loss is zero — we cover the same lines via the repo test.

const mockQuery = vi.fn()
vi.mock('../../server/utils/platform/database', () => ({
  useDatabasePool: () => ({ query: mockQuery })
}))

const { cloneYjsStateWithUrlRewrite } = await import('../../server/utils/documents/cloneYjsState')

function rowFromDoc(doc: Y.Doc): { value: Buffer } {
  return { value: Buffer.from(Y.encodeStateAsUpdate(doc)) }
}

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

describe('cloneYjsState — non-obvious contracts', () => {
  it('SRC\'s full-path rewrite does NOT touch a docId that HAS SRC as a substring (SRCX)', async () => {
    // Security-adjacent: `replaceAll('/api/files/SRC/', ...)` anchors
    // on the TRAILING slash. A refactor that used a non-anchored
    // substring replace (e.g. accidentally dropping the trailing slash)
    // would also rewrite SRCX → TGTX, silently leaking image access
    // from one doc's duplicate into an unrelated doc.
    const src = new Y.Doc()
    src.getText('content').insert(0,
      '![](/api/files/SRCX/img.png) and ![](/api/files/SRC/img.png)'
    )
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [rowFromDoc(src)] })
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] })

    await cloneYjsStateWithUrlRewrite('SRC', 'TGT')

    const tgt = docFromInsertedUpdate(mockQuery.mock.calls[1] as [string, unknown[]])
    expect(tgt.getText('content').toString()).toBe(
      '![](/api/files/SRCX/img.png) and ![](/api/files/TGT/img.png)'
    )
  })

  it('external http(s) URLs are left untouched (don\'t accidentally rewrite example.com)', async () => {
    // Symmetric concern: the rewrite must only touch our own
    // `/api/files/{sourceDocId}/` paths. External references stay
    // verbatim. A regression that globally replaced every occurrence
    // of `sourceDocId` would mangle external URLs that happen to
    // contain the docId string.
    const src = new Y.Doc()
    src.getText('content').insert(0,
      '![](https://example.com/SRC.png)\n![](/api/files/SRC/local.png)'
    )
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [rowFromDoc(src)] })
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] })

    await cloneYjsStateWithUrlRewrite('SRC', 'TGT')

    const tgt = docFromInsertedUpdate(mockQuery.mock.calls[1] as [string, unknown[]])
    expect(tgt.getText('content').toString()).toBe(
      '![](https://example.com/SRC.png)\n![](/api/files/TGT/local.png)'
    )
  })

  it('the `_deleted` flag is DROPPED — duplicates must start un-deleted', async () => {
    // Sentinel contract: the source doc may transiently hold `_deleted:
    // true` during a concurrent delete. If that flag carried over, the
    // duplicate would appear soft-deleted on open. We explicitly filter
    // `_deleted` during the ymeta copy.
    const src = new Y.Doc()
    src.getText('content').insert(0, 'body')
    const meta = src.getMap('meta')
    meta.set('title', 'Title')
    meta.set('_deleted', true)
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [rowFromDoc(src)] })
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] })

    await cloneYjsStateWithUrlRewrite('SRC', 'TGT')

    const tgt = docFromInsertedUpdate(mockQuery.mock.calls[1] as [string, unknown[]])
    expect(tgt.getMap('meta').get('title')).toBe('Title')
    expect(tgt.getMap('meta').get('_deleted')).toBeUndefined()
  })

  it('ymeta.theme custom CSS is pointed at the copy\'s uploads', async () => {
    const src = new Y.Doc()
    src.getText('content').insert(0, 'body')
    src.getMap('meta').set('theme', { body: { size: 11 }, customCss: 'p{background:url(/api/files/SRC/a.png)}' })
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [rowFromDoc(src)] })
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] })

    await cloneYjsStateWithUrlRewrite('SRC', 'TGT')

    const tgt = docFromInsertedUpdate(mockQuery.mock.calls[1] as [string, unknown[]])
    expect(tgt.getMap('meta').get('theme')).toEqual({
      body: { size: 11 },
      customCss: 'p{background:url(/api/files/TGT/a.png)}'
    })
  })
})
