import { describe, it, expect, beforeEach } from 'vitest'
// Documents must be built with the sync server's yjs copy (instanceof checks).
import * as Y from '../../../sync-server/src/yjs'
import * as encoding from 'lib0/encoding'
import { toBase64 } from 'lib0/buffer'
import { createUpdateGuard, SyncRejection, type ConnectionAccess } from '../../../sync-server/src/update-guard'
import { parseSyncLimits } from '../../../sync-server/src/limits'
import { syncEnvFrom } from '../../../sync-server/src/env'
import type { SuggestionRecord } from '../../../shared/utils/suggestions/record'

// The update guard's suggestion rules: every writer's `suggestions` map
// entries must be valid records, and a suggest-only connection may write
// only its own suggestions and comments: never the text, the settings or
// someone else's suggestion.

const DOC = 'doc-suggest'
const guard = createUpdateGuard(parseSyncLimits(syncEnvFrom({})))

function syncMessage(update: Uint8Array): Uint8Array {
  const enc = encoding.createEncoder()
  encoding.writeVarString(enc, DOC)
  encoding.writeVarUint(enc, 0)
  encoding.writeVarUint(enc, 2)
  encoding.writeVarUint8Array(enc, update)
  return encoding.toUint8Array(enc)
}

/** The update one transaction of `client` produces (what a provider sends). */
function transactionUpdate(client: Y.Doc, mutate: (client: Y.Doc) => void): Uint8Array {
  const updates: Uint8Array[] = []
  const record = (u: Uint8Array) => updates.push(u)
  client.on('update', record)
  try {
    mutate(client)
  } finally {
    client.off('update', record)
  }
  return Y.mergeUpdates(updates)
}

function clientOf(server: Y.Doc): Y.Doc {
  const c = new Y.Doc()
  Y.applyUpdate(c, Y.encodeStateAsUpdate(server))
  return c
}

function record(doc: Y.Doc, over: Partial<SuggestionRecord> = {}): SuggestionRecord {
  const text = doc.getText('content')
  const pos = toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, Math.min(2, text.length), 0)))
  return {
    v: 1,
    id: 'sugg-0001',
    start: pos,
    end: pos,
    text: 'new',
    deleted: '',
    authorId: 7,
    authorName: 'Bea',
    authorAvatarSeed: null,
    authorPrincipal: null,
    color: '#7A8C7E',
    createdAt: 1,
    updatedAt: 1,
    groupId: null,
    jobId: null,
    ...over
  }
}

const SUGGEST_7: ConnectionAccess = { suggestOnly: true, userId: '7' }
const FULL: ConnectionAccess = { suggestOnly: false, userId: '3' }

function reasonOf(fn: () => void): string | null {
  try {
    fn()
    return null
  } catch (e) {
    if (e instanceof SyncRejection) return e.reason
    throw e
  }
}

/** Run the guard, apply on success (what Hocuspocus does next). */
function send(server: Y.Doc, update: Uint8Array, access: ConnectionAccess): string | null {
  const reason = reasonOf(() => guard.check(server, syncMessage(update), false, access))
  if (reason === null) Y.applyUpdate(server, update)
  return reason
}

describe('update guard: suggestion records (every writer)', () => {
  let server: Y.Doc
  beforeEach(() => {
    server = new Y.Doc()
    Y.applyUpdate(server, transactionUpdate(clientOf(server), c => c.getText('content').insert(0, 'hello world')))
  })

  it('accepts a valid record stored under its id', () => {
    const c = clientOf(server)
    const u = transactionUpdate(c, d => d.getMap('suggestions').set('sugg-0001', record(d)))
    expect(send(server, u, FULL)).toBeNull()
    expect(server.getMap('suggestions').size).toBe(1)
  })

  it('refuses a record under another key, with unknown fields, or as a nested type', () => {
    const c = clientOf(server)
    expect(send(server, transactionUpdate(c, d => d.getMap('suggestions').set('other-key', record(d))), FULL)).toBe('invalid-suggestion')
    const c2 = clientOf(server)
    expect(send(server, transactionUpdate(c2, d => d.getMap('suggestions').set('sugg-0001', { ...record(d), extra: 'payload' })), FULL)).toBe('invalid-suggestion')
    const c3 = clientOf(server)
    expect(send(server, transactionUpdate(c3, d => d.getMap('suggestions').set('sugg-0001', new Y.Map())), FULL)).toBe('invalid-suggestion')
    expect(server.getMap('suggestions').size).toBe(0)
  })

  it('lets a full writer remove anyone\'s suggestion (rejecting it)', () => {
    send(server, transactionUpdate(clientOf(server), d => d.getMap('suggestions').set('sugg-0001', record(d))), SUGGEST_7)
    const c = clientOf(server)
    expect(send(server, transactionUpdate(c, d => d.getMap('suggestions').delete('sugg-0001')), FULL)).toBeNull()
    expect(server.getMap('suggestions').size).toBe(0)
  })
})

describe('update guard: suggest-only connections', () => {
  let server: Y.Doc
  beforeEach(() => {
    server = new Y.Doc()
    Y.applyUpdate(server, transactionUpdate(clientOf(server), (c) => {
      c.getText('content').insert(0, 'hello world')
      c.getMap('meta').set('title', 'Thesis')
    }))
  })

  it('accepts the author\'s own suggestion, an update of it and its removal', () => {
    const c = clientOf(server)
    expect(send(server, transactionUpdate(c, d => d.getMap('suggestions').set('sugg-0001', record(d))), SUGGEST_7)).toBeNull()
    expect(send(server, transactionUpdate(c, d => d.getMap('suggestions').set('sugg-0001', record(d, { text: 'newer', updatedAt: 2 }))), SUGGEST_7)).toBeNull()
    expect(send(server, transactionUpdate(c, d => d.getMap('suggestions').delete('sugg-0001')), SUGGEST_7)).toBeNull()
    expect(server.getMap('suggestions').size).toBe(0)
    expect(server.getText('content').toString()).toBe('hello world')
  })

  it('refuses typing into the text', () => {
    const c = clientOf(server)
    expect(send(server, transactionUpdate(c, d => d.getText('content').insert(5, '!')), SUGGEST_7)).toBe('invalid-suggestion')
    expect(server.getText('content').toString()).toBe('hello world')
  })

  it('refuses deleting text, also hidden in an otherwise allowed update', () => {
    const c = clientOf(server)
    const u = transactionUpdate(c, (d) => {
      d.getMap('suggestions').set('sugg-0001', record(d))
      d.getText('content').delete(0, 5)
    })
    expect(send(server, u, SUGGEST_7)).toBe('invalid-suggestion')
    expect(server.getText('content').toString()).toBe('hello world')
    expect(server.getMap('suggestions').size).toBe(0)
  })

  it('refuses document settings', () => {
    const c = clientOf(server)
    expect(send(server, transactionUpdate(c, d => d.getMap('meta').set('title', 'Mine now')), SUGGEST_7)).toBe('invalid-suggestion')
    expect(server.getMap('meta').get('title')).toBe('Thesis')
  })

  it('refuses a suggestion in someone else\'s name or as the AI', () => {
    const c = clientOf(server)
    expect(send(server, transactionUpdate(c, d => d.getMap('suggestions').set('sugg-0001', record(d, { authorId: 8 }))), SUGGEST_7)).toBe('invalid-suggestion')
    const c2 = clientOf(server)
    expect(send(server, transactionUpdate(c2, d => d.getMap('suggestions').set('sugg-0001', record(d, { authorId: null, authorPrincipal: 'ai:assistant:x' }))), SUGGEST_7)).toBe('invalid-suggestion')
  })

  it('refuses overwriting or removing another author\'s suggestion', () => {
    send(server, transactionUpdate(clientOf(server), d => d.getMap('suggestions').set('sugg-0001', record(d, { authorId: 8 }))), { suggestOnly: true, userId: '8' })
    const c = clientOf(server)
    expect(send(server, transactionUpdate(c, d => d.getMap('suggestions').set('sugg-0001', record(d))), SUGGEST_7)).toBe('invalid-suggestion')
    const c2 = clientOf(server)
    expect(send(server, transactionUpdate(c2, d => d.getMap('suggestions').delete('sugg-0001')), SUGGEST_7)).toBe('invalid-suggestion')
    expect(server.getMap('suggestions').size).toBe(1)
  })

  it('accepts a comment thread (replies to a suggestion live there)', () => {
    const c = clientOf(server)
    const u = transactionUpdate(c, (d) => {
      const m = new Y.Map<unknown>()
      m.set('id', 'thread-1')
      m.set('suggestionId', 'sugg-0001')
      m.set('replies', new Y.Array())
      d.getArray('comments').push([m])
    })
    expect(send(server, u, SUGGEST_7)).toBeNull()
    expect(server.getArray('comments').length).toBe(1)
  })

  it('lets anonymous suggesters write anonymous records only', () => {
    const anon: ConnectionAccess = { suggestOnly: true, userId: 'anonymous' }
    const c = clientOf(server)
    expect(send(server, transactionUpdate(c, d => d.getMap('suggestions').set('sugg-0001', record(d, { authorId: null, authorAvatarSeed: 'abc123' }))), anon)).toBeNull()
    const c2 = clientOf(server)
    expect(send(server, transactionUpdate(c2, d => d.getMap('suggestions').set('sugg-0002', record(d, { id: 'sugg-0002' }))), anon)).toBe('invalid-suggestion')
  })

  it('leaves read-only connections read-only (their updates are never applied)', () => {
    const c = clientOf(server)
    const u = transactionUpdate(c, d => d.getText('content').insert(0, 'x'))
    // The guard has nothing to check: Hocuspocus acks read-only updates without applying them.
    expect(reasonOf(() => guard.check(server, syncMessage(u), true, SUGGEST_7))).toBeNull()
  })
})
