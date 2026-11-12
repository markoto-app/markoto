import { describe, it, expect, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { nextTick } from 'vue'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import type { SerializedAnchor } from '../../app/utils/comments/commentAnchors'

// Composable wrapping the Y.Array<Y.Map> "comments" structure. Tests
// cover:
//   - empty initial state
//   - createComment writes a new entry, derives correctly on the next tick
//   - active vs orphaned classification (anchor null → orphan, sorted last)
//   - reply lifecycle via observeDeep
//   - resolved/delete flag flips
//
// Author identity is read from awareness; we stamp a name on the local
// state before the call so the deriver doesn't fall back to "Anonymous".
//
// Editing comments is intentionally NOT supported (product decision —
// users can only delete their own / resolve threads). No tests for an
// edit path.

const { sessionState } = vi.hoisted(() => {
  const user: { value: { id: number, name?: string } | null } = { value: { id: 1, name: 'Alice' } }
  return { sessionState: { loggedIn: { value: true }, user } }
})

mockNuxtImport('useUserSession', () => {
  return () => ({
    loggedIn: sessionState.loggedIn,
    user: sessionState.user
  })
})

// eslint-disable-next-line import/first -- mockNuxtImport must be hoisted above the import it mocks
import { useComments } from '~/composables/comments/useComments'

function makeYDoc() {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('content')
  const awareness = new Awareness(ydoc)
  awareness.setLocalStateField('user', { id: 1, name: 'Alice' })
  return { ydoc, ytext, awareness }
}

function anchorRange(ytext: Y.Text, ydoc: Y.Doc, from: number, to: number): SerializedAnchor {
  // Build a serialized anchor without going through CM's EditorView —
  // the helper expects a view, but the test only needs the underlying
  // Y.RelativePosition encoding. Re-implement the two-line equivalent
  // inline so we keep test deps minimal.
  const startRel = Y.createRelativePositionFromTypeIndex(ytext, from, 0)
  const endRel = Y.createRelativePositionFromTypeIndex(ytext, to, -1)
  const toBase64 = (b: Uint8Array) => {
    let s = ''
    for (const byte of b) s += String.fromCharCode(byte)
    return btoa(s)
  }
  return {
    start: toBase64(Y.encodeRelativePosition(startRel)),
    end: toBase64(Y.encodeRelativePosition(endRel))
  }
}

describe('useComments', () => {
  it('starts with an empty list', () => {
    const { ydoc, awareness } = makeYDoc()
    const { comments } = useComments(ydoc, awareness)
    expect(comments.value).toEqual([])
  })

  it('createComment writes to Y.Array and re-derives the list', async () => {
    const { ydoc, ytext, awareness } = makeYDoc()
    ytext.insert(0, 'the dog ate the bone')
    const { comments, createComment } = useComments(ydoc, awareness)

    const id = createComment(anchorRange(ytext, ydoc, 4, 7), 'about dogs')
    await nextTick()

    expect(comments.value).toHaveLength(1)
    expect(comments.value[0]!.id).toBe(id)
    expect(comments.value[0]!.body).toBe('about dogs')
    expect(comments.value[0]!.authorName).toBe('Alice')
    expect(comments.value[0]!.authorId).toBe(1)
    expect(comments.value[0]!.anchor).toEqual({ from: 4, to: 7 })
    expect(comments.value[0]!.resolved).toBe(false)
    expect(comments.value[0]!.replies).toEqual([])
  })

  it('stores no avatar for a signed-in author (seeded by authorId) and ignores a legacy authorAvatar URL', async () => {
    const { ydoc, ytext, awareness } = makeYDoc()
    ytext.insert(0, 'the dog ate the bone')
    const { comments, createComment } = useComments(ydoc, awareness)
    createComment(anchorRange(ytext, ydoc, 4, 7), 'about dogs')
    await nextTick()
    const raw = ydoc.getArray<Y.Map<unknown>>('comments').get(0)
    expect(raw.get('authorAvatarSeed')).toBeNull()
    expect(raw.has('authorAvatar')).toBe(false)
    expect(comments.value[0]!.authorAvatarSeed).toBeNull()

    // An older comment carrying a provider image URL renders without it.
    ydoc.transact(() => raw.set('authorAvatar', 'https://avatars.githubusercontent.com/u/1'))
    await nextTick()
    expect(comments.value[0]).not.toHaveProperty('authorAvatar')
  })

  it('keeps an anonymous author\'s session avatar token on the comment and rejects malformed ones', async () => {
    const ydoc = new Y.Doc()
    const ytext = ydoc.getText('content')
    const awareness = new Awareness(ydoc)
    awareness.setLocalStateField('user', { name: 'Quiet Fox', avatarSeed: 'Ab3dEf6hIj9kLm2n' })
    ytext.insert(0, 'the dog ate the bone')
    const { comments, createComment } = useComments(ydoc, awareness)
    createComment(anchorRange(ytext, ydoc, 4, 7), 'hello')
    await nextTick()
    expect(comments.value[0]!.authorId).toBeNull()
    expect(comments.value[0]!.authorAvatarSeed).toBe('Ab3dEf6hIj9kLm2n')

    const raw = ydoc.getArray<Y.Map<unknown>>('comments').get(0)
    ydoc.transact(() => raw.set('authorAvatarSeed', 'javascript:alert(1)'))
    await nextTick()
    expect(comments.value[0]!.authorAvatarSeed).toBeNull()
  })

  it('sorts active by anchor.from and appends orphans last', async () => {
    const { ydoc, ytext, awareness } = makeYDoc()
    ytext.insert(0, 'the dog ate the bone')
    const { comments, createComment } = useComments(ydoc, awareness)

    // Create three out of order. After sorting we expect the
    // anchor-position order: c2(4..7) → c1(8..11) → c3(orphan, last).
    const c1 = createComment(anchorRange(ytext, ydoc, 8, 11), 'mid')
    const c2 = createComment(anchorRange(ytext, ydoc, 4, 7), 'early')
    const c3 = createComment(anchorRange(ytext, ydoc, 16, 20), 'late')

    // Knock c3 out by deleting "bone" entirely → orphan.
    ytext.delete(16, 4)
    await nextTick()

    const ids = comments.value.map(c => c.id)
    expect(ids).toEqual([c2, c1, c3])
    expect(comments.value[0]!.anchor).toEqual({ from: 4, to: 7 })
    expect(comments.value[1]!.anchor).toEqual({ from: 8, to: 11 })
    expect(comments.value[2]!.anchor).toBeNull()
  })

  it('postReply observably appends to the thread', async () => {
    const { ydoc, ytext, awareness } = makeYDoc()
    ytext.insert(0, 'the dog ate the bone')
    const { comments, createComment, postReply } = useComments(ydoc, awareness)

    const id = createComment(anchorRange(ytext, ydoc, 4, 7), 'about dogs')
    postReply(id, 'a chicken bone')
    await nextTick()

    expect(comments.value[0]!.replies).toHaveLength(1)
    expect(comments.value[0]!.replies[0]!.body).toBe('a chicken bone')
    expect(comments.value[0]!.replies[0]!.authorName).toBe('Alice')
  })

  it('setResolved flips the flag', async () => {
    const { ydoc, ytext, awareness } = makeYDoc()
    ytext.insert(0, 'the dog ate the bone')
    const { comments, createComment, setResolved } = useComments(ydoc, awareness)

    const id = createComment(anchorRange(ytext, ydoc, 4, 7), 'about dogs')
    setResolved(id, true)
    await nextTick()
    expect(comments.value[0]!.resolved).toBe(true)
    setResolved(id, false)
    await nextTick()
    expect(comments.value[0]!.resolved).toBe(false)
  })

  it('deleteComment removes the entry', async () => {
    const { ydoc, ytext, awareness } = makeYDoc()
    ytext.insert(0, 'the dog ate the bone')
    const { comments, createComment, deleteComment } = useComments(ydoc, awareness)

    const id = createComment(anchorRange(ytext, ydoc, 4, 7), 'about dogs')
    expect(comments.value).toHaveLength(1)
    deleteComment(id)
    await nextTick()
    expect(comments.value).toEqual([])
  })

  it('falls back to Anonymous when awareness has no name', async () => {
    const { ydoc, ytext, awareness } = makeYDoc()
    awareness.setLocalStateField('user', undefined)
    ytext.insert(0, 'hello world')
    const { comments, createComment } = useComments(ydoc, awareness)

    createComment(anchorRange(ytext, ydoc, 0, 5), 'hi')
    await nextTick()
    expect(comments.value[0]!.authorName).toBe('Anonymous')
    expect(comments.value[0]!.authorId).toBeNull()
  })
})
