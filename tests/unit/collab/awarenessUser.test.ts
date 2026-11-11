import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import {
  normalizeAwarenessUser,
  normalizeAwarenessStates,
  AWARENESS_FALLBACK_COLOR,
  AWARENESS_FALLBACK_NAME,
  AWARENESS_NAME_MAX_LENGTH
} from '../../../shared/utils/documents/awarenessUser'

// Awareness `user` fields are chosen by each peer and relayed verbatim;
// they end up in raw style attributes (y-codemirror carets), inline
// styles (PresenceBar) and seed the generated avatar. The normaliser is the single
// definition of what is allowed through.

describe('normalizeAwarenessUser', () => {
  it('keeps a well-formed user unchanged', () => {
    const user = { name: 'Alice', color: '#7A8C7E', avatarSeed: 'Ab3dEf6hIj9kLm2n', id: 42 }
    expect(normalizeAwarenessUser(user)).toEqual(user)
  })

  it('replaces a colour carrying CSS with the fallback', () => {
    const out = normalizeAwarenessUser({ name: 'x', color: 'red; position: fixed; inset: 0' })
    expect(out?.color).toBe(AWARENESS_FALLBACK_COLOR)
  })

  it('accepts #rgb and #rrggbb, rejects named colours and alpha in `color`', () => {
    expect(normalizeAwarenessUser({ name: 'x', color: '#888' })?.color).toBe('#888')
    expect(normalizeAwarenessUser({ name: 'x', color: 'red' })?.color).toBe(AWARENESS_FALLBACK_COLOR)
    expect(normalizeAwarenessUser({ name: 'x', color: '#11223344' })?.color).toBe(AWARENESS_FALLBACK_COLOR)
  })

  it('keeps a hex colorLight (with alpha) and drops anything else', () => {
    expect(normalizeAwarenessUser({ name: 'x', color: '#888', colorLight: '#88888833' })?.colorLight).toBe('#88888833')
    expect(normalizeAwarenessUser({ name: 'x', color: '#888', colorLight: 'url(x)' })).not.toHaveProperty('colorLight')
  })

  it('falls back for non-string names and caps long ones', () => {
    expect(normalizeAwarenessUser({ name: 42 })?.name).toBe(AWARENESS_FALLBACK_NAME)
    expect(normalizeAwarenessUser({ name: '   ' })?.name).toBe(AWARENESS_FALLBACK_NAME)
    expect(normalizeAwarenessUser({ name: 'n'.repeat(500) })?.name).toHaveLength(AWARENESS_NAME_MAX_LENGTH)
  })

  it('strips control and bidi-override characters from names', () => {
    expect(normalizeAwarenessUser({ name: 'Al‮ice\u0000' })?.name).toBe('Alice')
  })

  it('drops avatar URLs of every kind — avatars are generated locally', () => {
    for (const avatar of ['https://avatars.githubusercontent.com/u/1', '/api/files/a/b.png', 'javascript:alert(1)', 'data:image/svg+xml,<svg/>']) {
      expect(normalizeAwarenessUser({ name: 'x', avatar })).not.toHaveProperty('avatar')
    }
  })

  it('keeps a short alphanumeric avatarSeed and drops anything else', () => {
    expect(normalizeAwarenessUser({ name: 'x', avatarSeed: 'Ab3dEf6hIj9kLm2n' })?.avatarSeed).toBe('Ab3dEf6hIj9kLm2n')
    for (const avatarSeed of ['', 'a'.repeat(33), 'u-1', 'a b', '<svg>', 42, null]) {
      expect(normalizeAwarenessUser({ name: 'x', avatarSeed })).not.toHaveProperty('avatarSeed')
    }
  })

  it('keeps positive integer ids, converts numeric strings, drops the rest', () => {
    expect(normalizeAwarenessUser({ name: 'x', id: 7 })?.id).toBe(7)
    expect(normalizeAwarenessUser({ name: 'x', id: '7' })?.id).toBe(7)
    expect(normalizeAwarenessUser({ name: 'x', id: 'anonymous' })).not.toHaveProperty('id')
    expect(normalizeAwarenessUser({ name: 'x', id: { toString: 1 } })).not.toHaveProperty('id')
    expect(normalizeAwarenessUser({ name: 'x', id: -1 })).not.toHaveProperty('id')
  })

  it('keeps isAI only when literally true and drops unknown fields', () => {
    expect(normalizeAwarenessUser({ name: 'x', isAI: 'yes', style: 'x' })).toEqual({ name: 'x', color: AWARENESS_FALLBACK_COLOR })
    expect(normalizeAwarenessUser({ name: 'x', isAI: true })?.isAI).toBe(true)
  })

  it('returns null for non-object input', () => {
    expect(normalizeAwarenessUser('x')).toBe(null)
    expect(normalizeAwarenessUser(null)).toBe(null)
    expect(normalizeAwarenessUser([1])).toBe(null)
  })
})

describe('normalizeAwarenessStates', () => {
  it('rewrites a received remote state in place and leaves the local state alone', () => {
    const local = new Awareness(new Y.Doc())
    local.setLocalStateField('user', { name: 'Me', color: 'not-validated-locally' })
    const peer = new Awareness(new Y.Doc())
    peer.setLocalState({ user: { name: 'Mallory', color: 'red;position:fixed' }, cursor: null })
    applyAwarenessUpdate(local, encodeAwarenessUpdate(peer, [peer.clientID]), 'remote')

    normalizeAwarenessStates(local, [peer.clientID, local.clientID])

    expect(local.getStates().get(peer.clientID)?.user).toEqual({ name: 'Mallory', color: AWARENESS_FALLBACK_COLOR })
    expect(local.getStates().get(local.clientID)?.user.color).toBe('not-validated-locally')
  })

  it('removes a user field that is not an object', () => {
    const local = new Awareness(new Y.Doc())
    const peer = new Awareness(new Y.Doc())
    peer.setLocalState({ user: 'nope' })
    applyAwarenessUpdate(local, encodeAwarenessUpdate(peer, [peer.clientID]), 'remote')
    normalizeAwarenessStates(local, [peer.clientID])
    expect(local.getStates().get(peer.clientID)).not.toHaveProperty('user')
  })
})
