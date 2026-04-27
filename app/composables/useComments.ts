import * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import { createInjectionState } from '@vueuse/core'
import { nanoid } from 'nanoid'
import { resolveAnchor, type SerializedAnchor } from '~/utils/commentAnchors'
import { COMMENT_BODY_MAX, REPLY_BODY_MAX } from '~/utils/commentBody'

// Comments live entirely in Y.js: a top-level `Y.Array` named "comments"
// holding `Y.Map` entries (one per thread). Replies are a nested
// `Y.Array<Y.Map>` inside each comment. y-postgresql persists the whole
// Y.Doc, so this is durable without any new SQL table.
//
// The composable observes the array deeply (so reply changes re-fire) and
// re-derives a plain Vue-reactive list every time. Cheaper than fine-grained
// observers, and keeps the diff tiny — comments are typically dozens, not
// thousands.

export interface DerivedReply {
  id: string
  body: string
  authorId: number | null
  authorName: string
  authorAvatar: string | null
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
  authorAvatar: string | null
  createdAt: number
  updatedAt: number
  resolved: boolean
  replies: DerivedReply[]
}

interface AuthorIdentity {
  id: number | null
  name: string
  avatar: string | null
}

function readAuthor(awareness: Awareness): AuthorIdentity {
  const local = awareness.getLocalState()
  const u = (local?.user ?? {}) as { id?: number, name?: string, avatar?: string }
  return {
    id: typeof u.id === 'number' ? u.id : null,
    name: typeof u.name === 'string' && u.name.length > 0 ? u.name : 'Anonymous',
    avatar: typeof u.avatar === 'string' && u.avatar.length > 0 ? u.avatar : null
  }
}

function deriveReply(map: Y.Map<unknown>): DerivedReply | null {
  const id = map.get('id')
  if (typeof id !== 'string') return null
  return {
    id,
    body: typeof map.get('body') === 'string' ? (map.get('body') as string) : '',
    authorId: typeof map.get('authorId') === 'number' ? (map.get('authorId') as number) : null,
    authorName: typeof map.get('authorName') === 'string' ? (map.get('authorName') as string) : 'Anonymous',
    authorAvatar: typeof map.get('authorAvatar') === 'string' ? (map.get('authorAvatar') as string) : null,
    createdAt: typeof map.get('createdAt') === 'number' ? (map.get('createdAt') as number) : 0,
    updatedAt: typeof map.get('updatedAt') === 'number' ? (map.get('updatedAt') as number) : 0
  }
}

function deriveComment(map: Y.Map<unknown>, ydoc: Y.Doc): DerivedComment | null {
  const id = map.get('id')
  if (typeof id !== 'string') return null
  const startB64 = map.get('anchorStart')
  const endB64 = map.get('anchorEnd')
  let anchor: { from: number, to: number } | null = null
  if (typeof startB64 === 'string' && typeof endB64 === 'string') {
    anchor = resolveAnchor({ start: startB64, end: endB64 } as SerializedAnchor, ydoc)
  }
  const repliesArr = map.get('replies')
  const replies: DerivedReply[] = []
  if (repliesArr instanceof Y.Array) {
    for (let i = 0; i < repliesArr.length; i++) {
      const r = repliesArr.get(i)
      if (r instanceof Y.Map) {
        const d = deriveReply(r as Y.Map<unknown>)
        if (d) replies.push(d)
      }
    }
  }
  return {
    id,
    anchor,
    body: typeof map.get('body') === 'string' ? (map.get('body') as string) : '',
    authorId: typeof map.get('authorId') === 'number' ? (map.get('authorId') as number) : null,
    authorName: typeof map.get('authorName') === 'string' ? (map.get('authorName') as string) : 'Anonymous',
    authorAvatar: typeof map.get('authorAvatar') === 'string' ? (map.get('authorAvatar') as string) : null,
    createdAt: typeof map.get('createdAt') === 'number' ? (map.get('createdAt') as number) : 0,
    updatedAt: typeof map.get('updatedAt') === 'number' ? (map.get('updatedAt') as number) : 0,
    resolved: Boolean(map.get('resolved')),
    replies
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
        const d = deriveComment(map as Y.Map<unknown>, ydoc)
        if (d) out.push(d)
      }
    }
    // Active (with a resolvable anchor) first, sorted by position. Orphans
    // stable-appended last by createdAt — keeps them visible without
    // disrupting the position-ordered active list.
    const active: DerivedComment[] = []
    const orphan: DerivedComment[] = []
    for (const c of out) (c.anchor ? active : orphan).push(c)
    active.sort((a, b) => (a.anchor!.from - b.anchor!.from) || (a.createdAt - b.createdAt))
    orphan.sort((a, b) => a.createdAt - b.createdAt)
    comments.value = [...active, ...orphan]
  }

  // observeDeep fires on any nested change (reply add/delete, body edit,
  // resolved toggle). Cheaper than fine-grained observers and easier to
  // reason about — the recompute walks at most a few hundred entries.
  const onDeep = () => recompute()
  ycomments.observeDeep(onDeep)

  // Y.js update events shift the underlying ytext too, which doesn't fire
  // observeDeep on `ycomments` but DOES change anchor resolution. Refresh
  // on every doc update so anchor positions stay in sync as users type.
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
        return { index: i, map: m as Y.Map<unknown> }
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
      map.set('authorAvatar', author.avatar)
      map.set('createdAt', now)
      map.set('updatedAt', now)
      map.set('resolved', false)
      map.set('replies', new Y.Array<Y.Map<unknown>>())
      ycomments.push([map])
    }, 'comments')
    return id
  }

  /**
   * Delete a comment. Routed through the REST endpoint so the server
   * can validate authorship — Y.js peers can't enforce that on their
   * own. The deletion lands locally via the live broadcast from the
   * server's trusted-client mutation, so the UI updates without an
   * optimistic-then-rollback round trip.
   */
  async function deleteComment(id: string): Promise<void> {
    if (!docId) {
      // Fallback for tests / callers without a docId — local-only path.
      const found = findCommentById(id)
      if (!found) return
      ydoc.transact(() => {
        ycomments.delete(found.index, 1)
      }, 'comments')
      return
    }
    await $fetch(`/api/docs/${docId}/comments/${id}`, { method: 'DELETE' })
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
      map.set('authorAvatar', author.avatar)
      map.set('createdAt', now)
      map.set('updatedAt', now)
      ;(repliesArr as Y.Array<Y.Map<unknown>>).push([map])
      // Bump the parent thread's updatedAt so "recently active" sorts work.
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
    await $fetch(`/api/docs/${docId}/comments/${commentId}/replies/${replyId}`, { method: 'DELETE' })
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

// Single-instance pattern. EditorLayout calls `useProvideComments` once
// and descendants (CommentsPanel) read it via `useCommentsContext`.
// Two instances would each attach observeDeep + ydoc.update listeners
// and recompute the list independently — same answer, twice the work,
// and a one-frame divergence on every change.
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
