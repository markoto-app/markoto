import * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import { createInjectionState } from '@vueuse/core'
import { nanoid } from 'nanoid'
import { resolveAnchor, type SerializedAnchor } from '~/utils/comments/commentAnchors'
import { COMMENT_BODY_MAX, REPLY_BODY_MAX } from '~/utils/comments/commentBody'

// Comments live entirely in Y.js: a top-level `Y.Array` "comments" of
// `Y.Map` threads, each with a nested `Y.Array<Y.Map>` of replies. They
// persist with the Y.Doc, so no SQL table is needed.
//
// The array is observed deeply and a plain reactive list is re-derived on
// every change: simpler than fine-grained observers, and comments number
// in the dozens.

export interface DerivedReply {
  id: string
  body: string
  authorId: number | null
  authorName: string
  /** Anonymous author's random avatar token (null for signed-in authors,
   *  whose avatar is seeded by `authorId`, and for the AI). */
  authorAvatarSeed: string | null
  createdAt: number
  updatedAt: number
}

export interface DerivedComment {
  id: string
  /** null when the anchored text has been entirely deleted (orphan). */
  anchor: { from: number, to: number } | null
  body: string
  authorId: number | null
  authorName: string
  /** Anonymous author's random avatar token (null for signed-in authors,
   *  whose avatar is seeded by `authorId`, and for the AI). */
  authorAvatarSeed: string | null
  createdAt: number
  updatedAt: number
  resolved: boolean
  replies: DerivedReply[]
}

interface AuthorIdentity {
  id: number | null
  name: string
  avatarSeed: string | null
}

function readAuthor(awareness: Awareness): AuthorIdentity {
  const local = awareness.getLocalState()
  const u = (local?.user ?? {}) as { id?: number, name?: string, avatarSeed?: string }
  const id = typeof u.id === 'number' ? u.id : null
  return {
    id,
    name: typeof u.name === 'string' && u.name.length > 0 ? u.name : 'Anonymous',
    avatarSeed: id === null && typeof u.avatarSeed === 'string' && u.avatarSeed.length > 0 ? u.avatarSeed : null
  }
}

/** Non-strings are dropped at the Y.Map boundary. */
function strField(map: Y.Map<unknown>, key: string, fallback = ''): string {
  const v = map.get(key)
  return typeof v === 'string' ? v : fallback
}

/** Non-numbers are dropped at the Y.Map boundary. */
function numField(map: Y.Map<unknown>, key: string, fallback = 0): number {
  const v = map.get(key)
  return typeof v === 'number' ? v : fallback
}

/** Same shape the awareness normaliser accepts; anything else is dropped
 *  because any peer can write comment maps. */
function avatarSeedField(map: Y.Map<unknown>): string | null {
  const v = map.get('authorAvatarSeed')
  return typeof v === 'string' && /^[A-Za-z0-9]{1,32}$/.test(v) ? v : null
}

function numOrNullField(map: Y.Map<unknown>, key: string): number | null {
  const v = map.get(key)
  return typeof v === 'number' ? v : null
}

/** Common author + timestamp fields shared by comments and replies. */
function deriveAuthorAndTimestamps(map: Y.Map<unknown>) {
  return {
    body: strField(map, 'body'),
    authorId: numOrNullField(map, 'authorId'),
    authorName: strField(map, 'authorName', 'Anonymous'),
    // A stored `authorAvatar` (provider image URL) is ignored: avatars are generated locally.
    authorAvatarSeed: avatarSeedField(map),
    createdAt: numField(map, 'createdAt'),
    updatedAt: numField(map, 'updatedAt')
  }
}

function deriveReply(map: Y.Map<unknown>): DerivedReply | null {
  const id = map.get('id')
  if (typeof id !== 'string') return null
  return { id, ...deriveAuthorAndTimestamps(map) }
}

/** Null if either anchor field is missing. */
function resolveCommentAnchor(map: Y.Map<unknown>, ydoc: Y.Doc): { from: number, to: number } | null {
  const startB64 = map.get('anchorStart')
  const endB64 = map.get('anchorEnd')
  if (typeof startB64 !== 'string' || typeof endB64 !== 'string') return null
  return resolveAnchor({ start: startB64, end: endB64 }, ydoc)
}

function deriveReplies(map: Y.Map<unknown>): DerivedReply[] {
  const repliesArr = map.get('replies')
  if (!(repliesArr instanceof Y.Array)) return []
  const replies: DerivedReply[] = []
  for (let i = 0; i < repliesArr.length; i++) {
    const r = repliesArr.get(i)
    if (r instanceof Y.Map) {
      const d = deriveReply(r as Y.Map<unknown>)
      if (d) replies.push(d)
    }
  }
  return replies
}

function deriveComment(map: Y.Map<unknown>, ydoc: Y.Doc): DerivedComment | null {
  const id = map.get('id')
  if (typeof id !== 'string') return null
  return {
    id,
    anchor: resolveCommentAnchor(map, ydoc),
    ...deriveAuthorAndTimestamps(map),
    resolved: Boolean(map.get('resolved')),
    replies: deriveReplies(map)
  }
}

export function useComments(ydoc: Y.Doc, awareness: Awareness, docId?: string) {
  const ycomments = ydoc.getArray<Y.Map<unknown>>('comments')

  const comments = ref<DerivedComment[]>([])

  function recompute() {
    const out: DerivedComment[] = []
    for (let i = 0; i < ycomments.length; i++) {
      const map = ycomments.get(i)
      if (map instanceof Y.Map) {
        const d = deriveComment(map, ydoc)
        if (d) out.push(d)
      }
    }
    // Anchored threads first by position; orphans (anchor text deleted) last by createdAt.
    const active: DerivedComment[] = []
    const orphan: DerivedComment[] = []
    for (const c of out) (c.anchor ? active : orphan).push(c)
    active.sort((a, b) => (a.anchor!.from - b.anchor!.from) || (a.createdAt - b.createdAt))
    orphan.sort((a, b) => a.createdAt - b.createdAt)
    comments.value = [...active, ...orphan]
  }

  // Fires on any nested change (reply, body edit, resolved toggle).
  const onDeep = () => recompute()
  ycomments.observeDeep(onDeep)

  // Typing shifts ytext, which doesn't fire observeDeep on `ycomments` but
  // does change anchor resolution, so refresh on every doc update.
  const onDocUpdate = () => recompute()
  ydoc.on('update', onDocUpdate)

  recompute()

  onUnmounted(() => {
    ycomments.unobserveDeep(onDeep)
    ydoc.off('update', onDocUpdate)
  })

  function findCommentById(id: string): { index: number, map: Y.Map<unknown> } | null {
    for (let i = 0; i < ycomments.length; i++) {
      const m = ycomments.get(i)
      if (m instanceof Y.Map && m.get('id') === id) {
        return { index: i, map: m }
      }
    }
    return null
  }

  function findReply(commentId: string, replyId: string): { commentMap: Y.Map<unknown>, repliesArr: Y.Array<Y.Map<unknown>>, index: number } | null {
    const found = findCommentById(commentId)
    if (!found) return null
    const repliesArr = found.map.get('replies')
    if (!(repliesArr instanceof Y.Array)) return null
    for (let i = 0; i < repliesArr.length; i++) {
      const r = repliesArr.get(i)
      if (r instanceof Y.Map && r.get('id') === replyId) {
        return { commentMap: found.map, repliesArr: repliesArr as Y.Array<Y.Map<unknown>>, index: i }
      }
    }
    return null
  }

  function createComment(anchor: SerializedAnchor, body: string): string {
    const author = readAuthor(awareness)
    const id = nanoid(12)
    const now = Date.now()
    const safeBody = body.slice(0, COMMENT_BODY_MAX)
    ydoc.transact(() => {
      const map = new Y.Map<unknown>()
      map.set('id', id)
      map.set('anchorStart', anchor.start)
      map.set('anchorEnd', anchor.end)
      map.set('body', safeBody)
      map.set('authorId', author.id)
      map.set('authorName', author.name)
      map.set('authorAvatarSeed', author.avatarSeed)
      map.set('createdAt', now)
      map.set('updatedAt', now)
      map.set('resolved', false)
      map.set('replies', new Y.Array<Y.Map<unknown>>())
      ycomments.push([map])
    }, 'comments')
    return id
  }

  /**
   * Goes through the REST endpoint so the server can validate authorship,
   * which Y.js peers can't enforce. The deletion arrives locally via the
   * server's broadcast, so there is no optimistic update to roll back.
   */
  async function deleteComment(id: string): Promise<void> {
    if (!docId) {
      // Local-only path for tests / callers without a docId.
      const found = findCommentById(id)
      if (!found) return
      ydoc.transact(() => {
        ycomments.delete(found.index, 1)
      }, 'comments')
      return
    }
    await apiFetch('/api/docs/:docId/comments/:commentId', { method: 'delete', path: { docId, commentId: id } })
  }

  function setResolved(id: string, resolved: boolean): void {
    const found = findCommentById(id)
    if (!found) return
    ydoc.transact(() => {
      found.map.set('resolved', resolved)
      found.map.set('updatedAt', Date.now())
    }, 'comments')
  }

  function postReply(commentId: string, body: string): string | null {
    const found = findCommentById(commentId)
    if (!found) return null
    const repliesArr = found.map.get('replies')
    if (!(repliesArr instanceof Y.Array)) return null
    const author = readAuthor(awareness)
    const replyId = nanoid(12)
    const now = Date.now()
    const safeBody = body.slice(0, REPLY_BODY_MAX)
    ydoc.transact(() => {
      const map = new Y.Map<unknown>()
      map.set('id', replyId)
      map.set('body', safeBody)
      map.set('authorId', author.id)
      map.set('authorName', author.name)
      map.set('authorAvatarSeed', author.avatarSeed)
      map.set('createdAt', now)
      map.set('updatedAt', now)
      ;(repliesArr as Y.Array<Y.Map<unknown>>).push([map])
      // Bumps the thread so "recently active" sorts work.
      found.map.set('updatedAt', now)
    }, 'comments')
    return replyId
  }

  async function deleteReply(commentId: string, replyId: string): Promise<void> {
    if (!docId) {
      const found = findReply(commentId, replyId)
      if (!found) return
      ydoc.transact(() => {
        found.repliesArr.delete(found.index, 1)
        found.commentMap.set('updatedAt', Date.now())
      }, 'comments')
      return
    }
    await apiFetch('/api/docs/:docId/comments/:commentId/replies/:replyId', { method: 'delete', path: { docId, commentId, replyId } })
  }

  return {
    comments: readonly(comments) as Readonly<Ref<readonly DerivedComment[]>>,
    createComment,
    deleteComment,
    setResolved,
    postReply,
    deleteReply
  }
}

export type CommentsApi = ReturnType<typeof useComments>

// EditorLayout calls `useProvideComments` once and descendants read it via
// `useCommentsContext`; a second instance would duplicate the observers and
// recompute independently, diverging for a frame on every change.
const [useProvideCommentsState, useInjectComments] = createInjectionState(
  (ydoc: Y.Doc, awareness: Awareness, docId?: string) => useComments(ydoc, awareness, docId)
)

export const useProvideComments = useProvideCommentsState

export function useCommentsContext(): CommentsApi {
  const api = useInjectComments()
  if (!api) {
    throw new Error('useCommentsContext() called outside a <CommentsPanel> ancestor that provides comments')
  }
  return api
}
