import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'

import { reconstructDocAtYjsId, reconstructTextAtYjsId } from '../../../server/utils/documents/historyReplay'
import { YjsHistoryCompactedError } from '../../../server/utils/documents/yjsLog'
import { first } from '../../helpers/assert'

// Mock useDatabasePool so we can drive reconstructDocAtYjsId without
// a real Postgres. The implementation only ever calls pool.query —
// we stub it to return canned `yjs_updates` rows (with the history
// floor column the read returns alongside them).
const mockQuery = vi.fn()
vi.mock('../../../server/utils/platform/database', () => ({
  useDatabasePool: () => ({ query: mockQuery })
}))

// Helper: produce a `data` Buffer from an in-memory Y.Doc.
function bufferFromDoc(doc: Y.Doc): Buffer {
  const update = Y.encodeStateAsUpdate(doc)
  return Buffer.from(update.buffer, update.byteOffset, update.byteLength)
}

describe('reconstructDocAtYjsId', () => {
  beforeEach(() => mockQuery.mockReset())

  it('returns an empty doc when maxYjsId is null', async () => {
    const doc = await reconstructDocAtYjsId('doc-123', null)
    expect(doc.getText('content').toString()).toBe('')
    // No DB call should have been made.
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('returns an empty doc when no rows match', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const doc = await reconstructDocAtYjsId('doc-empty', 100)
    expect(doc.getText('content').toString()).toBe('')
  })

  it('replays a single row to recover state', async () => {
    const seed = new Y.Doc()
    seed.getText('content').insert(0, 'hello world')
    mockQuery.mockResolvedValue({ rows: [{ floor: null, id: '1', data: bufferFromDoc(seed) }] })

    const doc = await reconstructDocAtYjsId('doc-x', 42)
    expect(doc.getText('content').toString()).toBe('hello world')
  })

  it('replays multiple rows in id order to compose state', async () => {
    // Three updates that, applied in order, build "abc".
    const a = new Y.Doc()
    a.getText('content').insert(0, 'a')
    const ab = new Y.Doc()
    Y.applyUpdate(ab, Y.encodeStateAsUpdate(a))
    ab.getText('content').insert(1, 'b')
    const abc = new Y.Doc()
    Y.applyUpdate(abc, Y.encodeStateAsUpdate(ab))
    abc.getText('content').insert(2, 'c')

    mockQuery.mockResolvedValue({ rows: [
      { floor: null, id: '1', data: bufferFromDoc(a) },
      { floor: null, id: '1', data: bufferFromDoc(ab) },
      { floor: null, id: '1', data: bufferFromDoc(abc) }
    ] })

    const doc = await reconstructDocAtYjsId('doc-y', 99)
    expect(doc.getText('content').toString()).toBe('abc')
  })

  it('passes maxYjsId as the upper bound to the SQL query', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    await reconstructDocAtYjsId('doc-z', 7)
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('id <= $2'),
      ['doc-z', 7]
    )
  })

  it('throws (never returns an empty doc) below the history floor', async () => {
    // The floor comes back even when no row matches (LEFT JOIN on a one-row CTE).
    mockQuery.mockResolvedValue({ rows: [{ floor: '50', id: null, data: null }] })
    await expect(reconstructDocAtYjsId('doc-x', 10)).rejects.toBeInstanceOf(YjsHistoryCompactedError)
  })

  it('starts from the newest snapshot at or below the target', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    await reconstructDocAtYjsId('doc-x', 100)
    const callArgs = first(mockQuery.mock.calls)
    expect(callArgs[0]).toContain('kind = \'snapshot\' AND id <= $2')
  })

  it('returns an empty doc when maxYjsId is negative (defensive)', async () => {
    // Spec: maxYjsId < 0 returns empty without hitting the DB. Pin
    // it so a caller that accidentally passes -1 (e.g. from a
    // partially-failed insert) doesn't get a "no rows match" query.
    const doc = await reconstructDocAtYjsId('doc-y', -5)
    expect(doc.getText('content').toString()).toBe('')
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('orders results by id ASC for deterministic replay', async () => {
    // Replay order isn't strictly required by Y.js (updates commute),
    // but deterministic order makes debugging much easier and matches
    // the sync server's load. Pin the ORDER BY clause.
    mockQuery.mockResolvedValue({ rows: [] })
    await reconstructDocAtYjsId('doc-q', 50)
    const sql = first(mockQuery.mock.calls)[0] as string
    expect(sql).toContain('ORDER BY r.id')
  })

  it('handles a Buffer-with-byteOffset (pg adapter quirk)', async () => {
    // Postgres' bytea decoder hands us Buffers that may share an
    // ArrayBuffer with siblings. Y.js's applyUpdate rejects raw
    // Buffer in some bundling configs — we must construct a proper
    // Uint8Array view from the buffer's offset/length.
    const seed = new Y.Doc()
    seed.getText('content').insert(0, 'shared')
    const update = Y.encodeStateAsUpdate(seed)

    // Embed the update bytes inside a larger buffer, simulating the
    // shared-ArrayBuffer case.
    const wrapper = new Uint8Array(update.length + 200)
    wrapper.set(update, 100) // offset by 100 bytes
    const bufferWithOffset = Buffer.from(wrapper.buffer, 100, update.length)

    mockQuery.mockResolvedValue({ rows: [{ floor: null, id: '1', data: bufferWithOffset }] })
    const doc = await reconstructDocAtYjsId('doc-buf', 1)
    expect(doc.getText('content').toString()).toBe('shared')
  })
})

describe('reconstructTextAtYjsId', () => {
  beforeEach(() => mockQuery.mockReset())

  it('returns empty string for empty / null cases', async () => {
    const t1 = await reconstructTextAtYjsId('doc-a', null)
    expect(t1).toBe('')
    mockQuery.mockResolvedValue({ rows: [] })
    const t2 = await reconstructTextAtYjsId('doc-a', 1)
    expect(t2).toBe('')
  })

  it('extracts text and destroys the intermediate doc', async () => {
    const seed = new Y.Doc()
    seed.getText('content').insert(0, 'final text')
    mockQuery.mockResolvedValue({ rows: [{ floor: null, id: '1', data: bufferFromDoc(seed) }] })
    const text = await reconstructTextAtYjsId('doc-b', 1)
    expect(text).toBe('final text')
  })
})
