import { describe, it, expect } from 'vitest'
import * as Y from '../../sync-server/src/yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import {
  attachAwarenessGuard,
  awarenessIdentities,
  writerIdentityFromContext
} from '../../sync-server/src/awareness-guard'
import { mostRecentVerifiedEditor } from '../../sync-server/src/activity-logger'
import { hashMetaTheme, readMetaSnapshot, UNREADABLE_THEME_HASH } from '../../sync-server/src/meta-snapshot'
import { AWARENESS_FALLBACK_COLOR } from '../../shared/utils/awarenessUser'

// Sync-server side of awareness hardening (M5) and attribution (M6),
// plus the defensive meta snapshot that keeps a corrupted doc loadable
// (H4).

interface FakeConnection {
  webSocket: object
  context: unknown
}

/** A stand-in for a Hocuspocus Document: a Y.Doc with awareness + connections. */
function fakeDocument(connections: FakeConnection[]) {
  const awareness = new Awareness(new Y.Doc())
  return { awareness, getConnections: () => connections }
}

function sendAwareness(
  target: Awareness,
  state: Record<string, unknown>,
  origin: object
): number {
  const peer = new Awareness(new Y.Doc())
  peer.setLocalState(state)
  applyAwarenessUpdate(target, encodeAwarenessUpdate(peer, [peer.clientID]), origin)
  return peer.clientID
}

describe('attachAwarenessGuard — normalisation before re-broadcast', () => {
  it('normalises a received user before the update listeners (the broadcast) run', () => {
    const doc = fakeDocument([])
    attachAwarenessGuard(doc)
    let broadcastUser: unknown
    // Registered after the guard, like Hocuspocus's own broadcast on `update`.
    doc.awareness.on('update', ({ updated, added }: { updated: number[], added: number[] }) => {
      const id = [...added, ...updated][0]
      if (id !== undefined) broadcastUser = doc.awareness.getStates().get(id)?.user
    })
    sendAwareness(doc.awareness, { user: { name: 'x', color: 'red;position:fixed', avatar: 'javascript:1' } }, {})
    expect(broadcastUser).toEqual({ name: 'x', color: AWARENESS_FALLBACK_COLOR })
  })
})

describe('attribution from awareness never trusts the client-chosen name', () => {
  it('maps an awareness client to the JWT identity of the connection it arrived on', () => {
    const anonSocket = {}
    const aliceSocket = {}
    const doc = fakeDocument([
      { webSocket: anonSocket, context: { readOnly: false, userId: 'anonymous', userName: null } },
      { webSocket: aliceSocket, context: { readOnly: false, userId: '7', userName: 'Alice' } }
    ])
    attachAwarenessGuard(doc)
    // Back to back, typically within the same millisecond: ordering must
    // not depend on the wall clock.
    sendAwareness(doc.awareness, { user: { name: 'Alice' } }, aliceSocket)
    // The anonymous editor claims to be someone else, and moves last.
    sendAwareness(doc.awareness, { user: { name: 'CEO Bob (forged)' } }, anonSocket)

    const editor = mostRecentVerifiedEditor(awarenessIdentities(doc))
    expect(editor).toEqual({ userId: 'anonymous', userName: null })
  })

  it('orders by arrival, so the last of two back-to-back updates wins either way round', () => {
    const anonSocket = {}
    const aliceSocket = {}
    const doc = fakeDocument([
      { webSocket: anonSocket, context: { readOnly: false, userId: 'anonymous', userName: null } },
      { webSocket: aliceSocket, context: { readOnly: false, userId: '7', userName: 'Alice' } }
    ])
    attachAwarenessGuard(doc)
    sendAwareness(doc.awareness, { user: { name: 'x' } }, anonSocket)
    sendAwareness(doc.awareness, { user: { name: 'Alice' } }, aliceSocket)
    expect(mostRecentVerifiedEditor(awarenessIdentities(doc))).toEqual({ userId: '7', userName: 'Alice' })
  })

  it('ignores read-only connections and unknown origins', () => {
    const viewerSocket = {}
    const doc = fakeDocument([
      { webSocket: viewerSocket, context: { readOnly: true, userId: '9', userName: 'Viewer' } }
    ])
    attachAwarenessGuard(doc)
    sendAwareness(doc.awareness, { user: { name: 'Viewer' } }, viewerSocket)
    sendAwareness(doc.awareness, { user: { name: 'Ghost' } }, {})
    expect(mostRecentVerifiedEditor(awarenessIdentities(doc))).toBe(null)
  })

  it('writerIdentityFromContext requires an explicit writer context', () => {
    expect(writerIdentityFromContext({ readOnly: false, userId: 3, userName: 'C' })).toEqual({ userId: '3', userName: 'C' })
    expect(writerIdentityFromContext({ userId: '3' })).toBe(null)
    expect(writerIdentityFromContext({ readOnly: false, userId: '' })).toBe(null)
    expect(writerIdentityFromContext(null)).toBe(null)
  })
})

describe('meta snapshot — a corrupted theme never throws', () => {
  it('hashes a deeply nested Y.Map theme as unreadable instead of overflowing the stack', () => {
    const doc = new Y.Doc()
    let cur = new Y.Map<unknown>()
    doc.getMap('meta').set('theme', cur)
    for (let i = 0; i < 200; i++) {
      const next = new Y.Map<unknown>()
      cur.set('n', next)
      cur = next
    }
    expect(() => readMetaSnapshot(doc)).not.toThrow()
    expect(readMetaSnapshot(doc).themeHash).toBe(UNREADABLE_THEME_HASH)
  })

  it('hashes a deeply nested JSON theme as unreadable', () => {
    let deep: Record<string, unknown> = {}
    for (let i = 0; i < 100_000; i++) deep = { n: deep }
    expect(hashMetaTheme(deep)).toBe(UNREADABLE_THEME_HASH)
  })

  it('hashes ordinary themes stably and treats non-objects as no theme', () => {
    expect(hashMetaTheme({ a: 1 })).toBe(hashMetaTheme({ a: 1 }))
    expect(hashMetaTheme({ a: 1 })).not.toBe(hashMetaTheme({ a: 2 }))
    expect(hashMetaTheme(undefined)).toBe(null)
    expect(hashMetaTheme('x')).toBe(null)
  })
})
