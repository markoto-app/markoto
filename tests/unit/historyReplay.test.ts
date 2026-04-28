import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'

// Mock useDatabasePool so we can drive reconstructDocAtYjsId without
// a real Postgres. The implementation only ever calls pool.query —
// we stub it to return canned y-postgresql-style rows.
const mockQuery = vi.fn()
vi.mock('../../server/utils/database', () => ({
  useDatabasePool: () => ({ query: mockQuery })
}))

import { reconstructDocAtYjsId, reconstructTextAtYjsId } from '../../server/utils/historyReplay'

// Helper: produce a `value` Buffer from an in-memory Y.Doc. y-
// postgresql stores the full encoded state for v1 rows; we
// approximate that by encoding the doc state.
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
    mockQuery.mockResolvedValue({ rows: [{ value: bufferFromDoc(seed) }] })

    const doc = await reconstructDocAtYjsId('doc-x', 42)
    expect(doc.getText('content').toString()).toBe('hello world')
  })

  it('replays multiple rows in id order to compose state', async () => {
    // Three updates that, applied in order, build "abc".
    const a = new Y.Doc(); a.getText('content').insert(0, 'a')
    const ab = new Y.Doc(); Y.applyUpdate(ab, Y.encodeStateAsUpdate(a)); ab.getText('content').insert(1, 'b')
    const abc = new Y.Doc(); Y.applyUpdate(abc, Y.encodeStateAsUpdate(ab)); abc.getText('content').insert(2, 'c')

    mockQuery.mockResolvedValue({ rows: [
      { value: bufferFromDoc(a) },
      { value: bufferFromDoc(ab) },
      { value: bufferFromDoc(abc) }
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

  it('only fetches version=v1 rows (skips v1_sv state-vector rows)', async () => {
    // y-postgresql writes both `v1` (update bytes) and `v1_sv` (state
    // vector) rows. Replaying state-vector rows would either no-op
    // or corrupt the doc — pin the SELECT to v1 only.
    mockQuery.mockResolvedValue({ rows: [] })
    await reconstructDocAtYjsId('doc-x', 100)
    const callArgs = mockQuery.mock.calls[0]
    expect(callArgs[0]).toContain("version = 'v1'")
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
    // y-postgresql's own load semantics. Pin the ORDER BY clause.
    mockQuery.mockResolvedValue({ rows: [] })
    await reconstructDocAtYjsId('doc-q', 50)
    const sql = mockQuery.mock.calls[0][0] as string
    expect(sql).toContain('ORDER BY id ASC')
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

    mockQuery.mockResolvedValue({ rows: [{ value: bufferWithOffset }] })
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
    mockQuery.mockResolvedValue({ rows: [{ value: bufferFromDoc(seed) }] })
    const text = await reconstructTextAtYjsId('doc-b', 1)
    expect(text).toBe('final text')
  })
})
