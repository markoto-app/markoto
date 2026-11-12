import { describe, it, expect, beforeEach } from 'vitest'
// The sync server resolves its own yjs copy; documents under test must be
// built with that same copy (Y.js relies on instanceof checks).
import * as Y from '../../../sync-server/src/yjs'
import * as encoding from 'lib0/encoding'
import { createUpdateGuard, extractSyncUpdate, SyncRejection } from '../../../sync-server/src/update-guard'
import { parseSyncLimits, DEFAULT_MAX_DOCUMENT_BYTES } from '../../../sync-server/src/limits'
import { syncEnvFrom } from '../../../sync-server/src/env'
import { defaultTheme } from '../../../shared/utils/theme/defaultTheme'

const limitsFrom = (raw: Record<string, string | undefined>) => parseSyncLimits(syncEnvFrom(raw))

// Pre-apply validation of client updates (H3 size limits + H4 ymeta
// validation on the WebSocket path). Each test plays a client against a
// server-side Y.Doc: the client's update is framed exactly like a
// Hocuspocus sync message, run through the guard, and, if accepted,
// applied to the server doc, mirroring what Hocuspocus does next.

const DOC = 'doc-guard'

/** Hocuspocus frame: varString(doc) varUint(Sync=0) varUint(Update=2) varUint8Array(update). */
function syncMessage(update: Uint8Array, docName = DOC): Uint8Array {
  const enc = encoding.createEncoder()
  encoding.writeVarString(enc, docName)
  encoding.writeVarUint(enc, 0)
  encoding.writeVarUint(enc, 2)
  encoding.writeVarUint8Array(enc, update)
  return encoding.toUint8Array(enc)
}

function awarenessMessage(): Uint8Array {
  const enc = encoding.createEncoder()
  encoding.writeVarString(enc, DOC)
  encoding.writeVarUint(enc, 1)
  encoding.writeVarUint8Array(enc, new Uint8Array([0]))
  return encoding.toUint8Array(enc)
}

/** Run `mutate` on a client that is in sync with `server`; return the update it produced. */
function clientUpdate(server: Y.Doc, mutate: (client: Y.Doc) => void, client?: Y.Doc): Uint8Array {
  const c = client ?? new Y.Doc()
  if (!client) Y.applyUpdate(c, Y.encodeStateAsUpdate(server))
  const before = Y.encodeStateVector(c)
  mutate(c)
  return Y.encodeStateAsUpdate(c, before)
}

function rejectionOf(fn: () => void): SyncRejection | null {
  try {
    fn()
    return null
  } catch (e) {
    if (e instanceof SyncRejection) return e
    throw e
  }
}

describe('update guard: sizes', () => {
  let server: Y.Doc
  beforeEach(() => {
    server = new Y.Doc()
  })

  it('accepts an ordinary edit', () => {
    const guard = createUpdateGuard(limitsFrom({}))
    const update = clientUpdate(server, c => c.getText('content').insert(0, 'hello'))
    expect(() => guard.check(server, syncMessage(update), false)).not.toThrow()
  })

  it('rejects an update above SYNC_MAX_UPDATE_BYTES', () => {
    const guard = createUpdateGuard(limitsFrom({ SYNC_MAX_UPDATE_BYTES: '1000' }))
    const update = clientUpdate(server, c => c.getText('content').insert(0, 'x'.repeat(2000)))
    const r = rejectionOf(() => guard.check(server, syncMessage(update), false))
    expect(r?.reason).toBe('update-too-large')
    expect(r?.code).toBe(4413)
  })

  it('rejects a message above SYNC_MAX_MESSAGE_BYTES', () => {
    const guard = createUpdateGuard(limitsFrom({ SYNC_MAX_MESSAGE_BYTES: '500' }))
    const update = clientUpdate(server, c => c.getText('content').insert(0, 'x'.repeat(600)))
    expect(rejectionOf(() => guard.check(server, syncMessage(update), false))?.reason).toBe('update-too-large')
  })

  it('rejects updates that grow the document past SYNC_MAX_DOCUMENT_BYTES, across many small updates', () => {
    const guard = createUpdateGuard(limitsFrom({ SYNC_MAX_DOCUMENT_BYTES: '4000' }))
    const client = new Y.Doc()
    let rejected: SyncRejection | null = null
    for (let i = 0; i < 20 && !rejected; i++) {
      const update = clientUpdate(server, c => c.getText('content').insert(0, 'y'.repeat(500)), client)
      rejected = rejectionOf(() => guard.check(server, syncMessage(update), false))
      if (!rejected) Y.applyUpdate(server, update)
    }
    expect(rejected?.reason).toBe('document-too-large')
    expect(Y.encodeStateAsUpdate(server).byteLength).toBeLessThanOrEqual(4000)
  })

  it('still accepts deletions on a document at the size cap, so it can be trimmed', () => {
    const big = new Y.Doc()
    big.getText('content').insert(0, 'z'.repeat(5000))
    Y.applyUpdate(server, Y.encodeStateAsUpdate(big))
    const guard = createUpdateGuard(limitsFrom({ SYNC_MAX_DOCUMENT_BYTES: '1000' }))
    const update = clientUpdate(server, c => c.getText('content').delete(0, 4000))
    expect(() => guard.check(server, syncMessage(update), false)).not.toThrow()
  })

  it('skips validation for read-only connections (their updates are never applied)', () => {
    const guard = createUpdateGuard(limitsFrom({ SYNC_MAX_UPDATE_BYTES: '10' }))
    const update = clientUpdate(server, c => c.getText('content').insert(0, 'x'.repeat(100)))
    expect(() => guard.check(server, syncMessage(update), true)).not.toThrow()
  })

  it('ignores non-update messages', () => {
    const guard = createUpdateGuard(limitsFrom({}))
    expect(() => guard.check(server, awarenessMessage(), false)).not.toThrow()
  })

  it('rejects a truncated sync message as invalid-update', () => {
    const full = syncMessage(clientUpdate(server, c => c.getText('content').insert(0, 'abc')))
    expect(() => extractSyncUpdate(full.subarray(0, full.length - 2))).toThrow(SyncRejection)
  })
})

describe('update guard: ymeta validation on the WebSocket path', () => {
  let server: Y.Doc
  const guard = createUpdateGuard(limitsFrom({}))

  function accept(update: Uint8Array) {
    guard.check(server, syncMessage(update), false)
    Y.applyUpdate(server, update)
  }

  beforeEach(() => {
    server = new Y.Doc()
    // Existing doc state: a title, a valid theme, some content.
    accept(clientUpdate(server, (c) => {
      c.getMap('meta').set('title', 'Original')
      c.getMap('meta').set('theme', defaultTheme)
      c.getText('content').insert(0, '# Doc')
    }))
  })

  it('accepts valid title / theme / description / audience / language writes', () => {
    expect(() => accept(clientUpdate(server, (c) => {
      const m = c.getMap('meta')
      m.set('title', 'Renamed')
      m.set('theme', { ...defaultTheme })
      m.set('description', 'About this doc')
      m.set('audience', 'casual')
      m.set('language', 'de')
    }))).not.toThrow()
    expect(server.getMap('meta').get('title')).toBe('Renamed')
  })

  it('rejects an over-long title written over an existing one (parent implied by origin)', () => {
    const update = clientUpdate(server, c => c.getMap('meta').set('title', 't'.repeat(256)))
    // The overwrite carries no explicit parent, the guard has to follow
    // the origin reference into the server's store to place it.
    expect(Y.decodeUpdate(update).structs.some(s => s instanceof Y.Item && s.parent === null)).toBe(true)
    expect(rejectionOf(() => guard.check(server, syncMessage(update), false))?.reason).toBe('invalid-meta')
  })

  it('rejects a theme that fails the schema', () => {
    const update = clientUpdate(server, c => c.getMap('meta').set('theme', { ...defaultTheme, pageSize: 'Banana' }))
    expect(rejectionOf(() => guard.check(server, syncMessage(update), false))?.reason).toBe('invalid-meta')
  })

  it('rejects a deeply nested JSON theme', () => {
    let deep: Record<string, unknown> = {}
    for (let i = 0; i < 200; i++) deep = { n: deep }
    const update = clientUpdate(server, c => c.getMap('meta').set('theme', deep))
    expect(rejectionOf(() => guard.check(server, syncMessage(update), false))?.reason).toBe('invalid-meta')
  })

  it('rejects a nested Y type as theme, and writes nested inside it', () => {
    const update = clientUpdate(server, (c) => {
      let cur = new Y.Map<unknown>()
      c.getMap('meta').set('theme', cur)
      for (let i = 0; i < 500; i++) {
        const next = new Y.Map<unknown>()
        cur.set('n', next)
        cur = next
      }
    })
    expect(rejectionOf(() => guard.check(server, syncMessage(update), false))?.reason).toBe('invalid-meta')
  })

  it('rejects an invalid audience and a Y.Text under a meta key', () => {
    const a = clientUpdate(server, c => c.getMap('meta').set('audience', 'pirate'))
    expect(rejectionOf(() => guard.check(server, syncMessage(a), false))?.reason).toBe('invalid-meta')
    const b = clientUpdate(server, c => c.getMap('meta').set('description', new Y.Text('x')))
    expect(rejectionOf(() => guard.check(server, syncMessage(b), false))?.reason).toBe('invalid-meta')
  })

  it('accepts comment threads (nested Y types outside ymeta)', () => {
    expect(() => accept(clientUpdate(server, (c) => {
      const thread = new Y.Map<unknown>()
      c.getArray('comments').push([thread])
      thread.set('body', 'hi')
      thread.set('replies', new Y.Array())
    }))).not.toThrow()
  })

  it('accepts small values under unknown keys (newer clients) but not large ones', () => {
    expect(() => accept(clientUpdate(server, c => c.getMap('meta').set('futureFlag', true)))).not.toThrow()
    const big = clientUpdate(server, c => c.getMap('meta').set('futureBlob', 'x'.repeat(5000)))
    expect(rejectionOf(() => guard.check(server, syncMessage(big), false))?.reason).toBe('invalid-meta')
  })

  it('rejects an update that references state the server never received', () => {
    const client = new Y.Doc()
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server))
    // First write is withheld; the second one is placed relative to it.
    clientUpdate(server, c => c.getMap('meta').set('title', 'withheld'), client)
    const second = clientUpdate(server, c => c.getMap('meta').set('title', 'second'), client)
    expect(rejectionOf(() => guard.check(server, syncMessage(second), false))?.reason).toBe('invalid-update')
  })

  it('lets a valid theme overwrite an already-corrupted one (repair path)', () => {
    // Corrupt the server doc directly (as an old, unvalidated write would have).
    const corrupt = new Y.Doc()
    Y.applyUpdate(corrupt, Y.encodeStateAsUpdate(server))
    let cur = new Y.Map<unknown>()
    corrupt.getMap('meta').set('theme', cur)
    for (let i = 0; i < 50; i++) {
      const next = new Y.Map<unknown>()
      cur.set('n', next)
      cur = next
    }
    Y.applyUpdate(server, Y.encodeStateAsUpdate(corrupt, Y.encodeStateVector(server)))
    expect(server.getMap('meta').get('theme')).toBeInstanceOf(Y.Map)

    expect(() => accept(clientUpdate(server, c => c.getMap('meta').set('theme', defaultTheme)))).not.toThrow()
    expect(server.getMap('meta').get('theme')).toEqual(defaultTheme)
  })
})

describe('parseSyncLimits', () => {
  it('uses defaults for missing values', () => {
    const l = limitsFrom({})
    expect(l.maxDocumentBytes).toBe(DEFAULT_MAX_DOCUMENT_BYTES)
    expect(l.maxUpdateBytes).toBeGreaterThan(0)
  })

  it('refuses invalid values instead of silently keeping the default', () => {
    expect(() => limitsFrom({ SYNC_MAX_DOCUMENT_BYTES: 'abc' })).toThrow(/SYNC_MAX_DOCUMENT_BYTES/)
    expect(() => limitsFrom({ SYNC_MAX_UPDATE_BYTES: '-5' })).toThrow(/SYNC_MAX_UPDATE_BYTES/)
  })

  it('reads positive integers', () => {
    expect(limitsFrom({ SYNC_MAX_MESSAGE_BYTES: '1234' }).maxMessageBytes).toBe(1234)
  })
})

describe('update guard: stateless messages', () => {
  /** varString(doc) varUint(type) varString(payload): Stateless (5) / BroadcastStateless (6). */
  function statelessMessage(type: 5 | 6, payload = 'hello'): Uint8Array {
    const enc = encoding.createEncoder()
    encoding.writeVarString(enc, DOC)
    encoding.writeVarUint(enc, type)
    encoding.writeVarString(enc, payload)
    return encoding.toUint8Array(enc)
  }

  it('refuses broadcast and plain stateless messages from a read-only connection', () => {
    const guard = createUpdateGuard(limitsFrom({}))
    const server = new Y.Doc()
    for (const type of [5, 6] as const) {
      const r = rejectionOf(() => guard.check(server, statelessMessage(type), true))
      expect(r?.reason).toBe('invalid-update')
      expect(r?.message).toContain('read-only')
    }
  })

  it('keeps stateless messages from writers', () => {
    const guard = createUpdateGuard(limitsFrom({}))
    const server = new Y.Doc()
    expect(() => guard.check(server, statelessMessage(6), false)).not.toThrow()
    expect(() => guard.check(server, statelessMessage(5), false)).not.toThrow()
  })

  it('still lets read-only connections send awareness and sync messages', () => {
    const guard = createUpdateGuard(limitsFrom({}))
    const server = new Y.Doc()
    expect(() => guard.check(server, awarenessMessage(), true)).not.toThrow()
    const update = clientUpdate(server, c => c.getText('content').insert(0, 'x'))
    expect(() => guard.check(server, syncMessage(update), true)).not.toThrow()
  })
})
