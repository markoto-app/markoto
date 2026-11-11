import { describe, it, expect, vi } from 'vitest'
import {
  performKickUser,
  type HocuspocusConnection,
  type HocuspocusDocument,
  type HocuspocusInstance
} from '../../../sync-server/src/kickUser'
import { SYNC_CLOSE_CODES, SYNC_REAUTH_REASON } from '../../../shared/contracts/syncClose'

// Fake Hocuspocus instance builder. We don't need a real Y.Doc here — the
// kick-user logic only touches `documents.get()` + `doc.getConnections()`.
// Casting a plain object to the structural type keeps the test focused on
// the branching logic we actually care about.
function makeInstance(
  docs: Record<string, HocuspocusConnection[]>
): HocuspocusInstance {
  const map = new Map<string, HocuspocusDocument>()
  for (const [docId, connections] of Object.entries(docs)) {
    const fakeDoc = {
      getConnections: () => connections
    } as unknown as HocuspocusDocument
    map.set(docId, fakeDoc)
  }
  return { documents: map }
}

function conn(userId: number | string | null, closeSpy?: () => void): HocuspocusConnection {
  return {
    context: { userId },
    close: closeSpy ?? vi.fn()
  }
}

describe('performKickUser', () => {
  it('closes only connections matching targetUserId', () => {
    const aliceClose = vi.fn()
    const bobClose = vi.fn()
    const instance = makeInstance({
      'doc-1': [conn(42, aliceClose), conn(99, bobClose)]
    })
    const result = performKickUser(instance, '42', ['doc-1'])
    expect(aliceClose).toHaveBeenCalledTimes(1)
    expect(bobClose).not.toHaveBeenCalled()
    expect(result).toEqual({ kicked: 1, missing: 0 })
  })

  it('kicks the same user across multiple docs', () => {
    const close1 = vi.fn()
    const close2 = vi.fn()
    const instance = makeInstance({
      'doc-1': [conn(42, close1)],
      'doc-2': [conn(42, close2)]
    })
    const result = performKickUser(instance, '42', ['doc-1', 'doc-2'])
    expect(close1).toHaveBeenCalledTimes(1)
    expect(close2).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ kicked: 2, missing: 0 })
  })

  it('kicks multiple connections for the same user on the same doc', () => {
    // A single user with two tabs open. Both should drop.
    const tab1 = vi.fn()
    const tab2 = vi.fn()
    const instance = makeInstance({
      'doc-1': [conn(42, tab1), conn(42, tab2)]
    })
    const result = performKickUser(instance, '42', ['doc-1'])
    expect(tab1).toHaveBeenCalledTimes(1)
    expect(tab2).toHaveBeenCalledTimes(1)
    expect(result.kicked).toBe(2)
  })

  it('counts docs not loaded separately from kicked', () => {
    const close = vi.fn()
    const instance = makeInstance({ 'doc-1': [conn(42, close)] })
    const result = performKickUser(instance, '42', ['doc-1', 'doc-2', 'doc-3'])
    expect(close).toHaveBeenCalledOnce()
    expect(result).toEqual({ kicked: 1, missing: 2 })
  })

  it('matches number-vs-string userId (JWT payload variation)', () => {
    // App sends targetUserId as a stringified number; connection context
    // may carry number (logged-in JWT). Must not silently skip.
    const close = vi.fn()
    const instance = makeInstance({ 'doc-1': [conn(42, close)] })
    performKickUser(instance, '42', ['doc-1'])
    expect(close).toHaveBeenCalledOnce()
  })

  it('matches the anonymous sentinel string userId', () => {
    const close = vi.fn()
    const instance = makeInstance({ 'doc-1': [conn('anonymous', close)] })
    performKickUser(instance, 'anonymous', ['doc-1'])
    expect(close).toHaveBeenCalledOnce()
  })

  it('does not match an anonymous connection when kicking a real user', () => {
    // Guard against over-kick: an anon session on the same doc should
    // survive when we're targeting userId=42.
    const anonClose = vi.fn()
    const aliceClose = vi.fn()
    const instance = makeInstance({
      'doc-1': [conn('anonymous', anonClose), conn(42, aliceClose)]
    })
    performKickUser(instance, '42', ['doc-1'])
    expect(anonClose).not.toHaveBeenCalled()
    expect(aliceClose).toHaveBeenCalledOnce()
  })

  it('skips connections with no userId context (defensive)', () => {
    const close = vi.fn()
    const instance = makeInstance({
      'doc-1': [{ context: {}, close }, { close }] as HocuspocusConnection[]
    })
    performKickUser(instance, '42', ['doc-1'])
    expect(close).not.toHaveBeenCalled()
  })

  it('skips connections with explicit null userId', () => {
    const close = vi.fn()
    const instance = makeInstance({ 'doc-1': [conn(null, close)] })
    performKickUser(instance, '42', ['doc-1'])
    expect(close).not.toHaveBeenCalled()
  })

  it('continues iterating when one close() throws', () => {
    // If Hocuspocus's close() throws for some reason (connection already
    // dead, transport bug), we must not stop the loop — other legitimate
    // kicks on the same doc need to land. Silent security hole otherwise.
    const throwingClose = vi.fn(() => {
      throw new Error('already closed')
    })
    const goodClose = vi.fn()
    const instance = makeInstance({
      'doc-1': [conn(42, throwingClose), conn(42, goodClose)]
    })
    const result = performKickUser(instance, '42', ['doc-1'])
    expect(throwingClose).toHaveBeenCalledOnce()
    expect(goodClose).toHaveBeenCalledOnce()
    // Only the non-throwing close counted as kicked.
    expect(result.kicked).toBe(1)
  })

  it('handles doc with no getConnections method (older Hocuspocus shape)', () => {
    const instance: HocuspocusInstance = {
      documents: new Map([['doc-1', {} as unknown as HocuspocusDocument]])
    }
    const result = performKickUser(instance, '42', ['doc-1'])
    expect(result).toEqual({ kicked: 0, missing: 0 })
  })

  it('returns zero kicked/missing for empty docIds list', () => {
    const instance = makeInstance({ 'doc-1': [conn(42)] })
    expect(performKickUser(instance, '42', [])).toEqual({ kicked: 0, missing: 0 })
  })

  it('handles instance with no documents map at all', () => {
    // `documents` is optional on our structural type. Don't crash.
    const instance: HocuspocusInstance = {}
    const result = performKickUser(instance, '42', ['doc-1'])
    expect(result).toEqual({ kicked: 0, missing: 1 })
  })

  it('closes with the re-authenticate reason and drops the socket, so the editor refetches its token', () => {
    const close = vi.fn()
    const socketClose = vi.fn()
    const instance = makeInstance({ 'doc-1': [{ context: { userId: 42 }, close, webSocket: { close: socketClose } }] })
    performKickUser(instance, '42', ['doc-1'])
    expect(close).toHaveBeenCalledWith({ code: SYNC_CLOSE_CODES.reauthenticate, reason: SYNC_REAUTH_REASON })
    expect(socketClose).toHaveBeenCalledWith(SYNC_CLOSE_CODES.reauthenticate, SYNC_REAUTH_REASON)
  })
})
