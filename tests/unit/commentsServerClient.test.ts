import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import {
  findComment,
  readCommentAuthor,
  readReplyAuthor
} from '../../server/utils/commentsServerClient'

// Pure helpers from `commentsServerClient.ts` — `openTrustedCommentClient`
// itself needs a live Hocuspocus and is exercised in the integration
// suite. The lookup + author-derivation helpers here are pure and
// unit-testable against a synthetic Y.Doc.
//
// What we lock in:
//   - findComment returns the entry by id, NOT by index — order in
//     the array doesn't matter for delete authorisation.
//   - findComment returns null for an unknown id (no false positives).
//   - readCommentAuthor extracts authorId only when it's a number;
//     anonymous authors land with `null` so authz can decide they
//     can't author-delete.
//   - readReplyAuthor walks the parent's nested replies array; misses
//     return null without throwing.

// Y.Map values are only durable once the map is attached to a Y.Doc
// (via insertion into a Y.Array or assignment into a Y.Map slot). The
// helpers below build the map, push it into the array first, then
// populate fields — same lifecycle the production composable uses.

interface CommentFields {
  authorId?: number | null
  authorName?: string
  body?: string
}

function pushComment(arr: Y.Array<Y.Map<unknown>>, id: string, fields: CommentFields = {}): Y.Map<unknown> {
  const map = new Y.Map<unknown>()
  arr.push([map])
  map.set('id', id)
  map.set('authorId', 'authorId' in fields ? (fields.authorId ?? null) : null)
  map.set('authorName', fields.authorName ?? 'Anon')
  map.set('body', fields.body ?? '')
  map.set('replies', new Y.Array<Y.Map<unknown>>())
  return map
}

function pushReply(parentMap: Y.Map<unknown>, id: string, fields: CommentFields = {}): Y.Map<unknown> {
  const replies = parentMap.get('replies') as Y.Array<Y.Map<unknown>>
  const map = new Y.Map<unknown>()
  replies.push([map])
  map.set('id', id)
  map.set('authorId', 'authorId' in fields ? (fields.authorId ?? null) : null)
  map.set('authorName', fields.authorName ?? 'Anon')
  map.set('body', fields.body ?? '')
  return map
}

describe('findComment', () => {
  it('returns null when the comment id does not exist', () => {
    const ydoc = new Y.Doc()
    const arr = ydoc.getArray<Y.Map<unknown>>('comments')
    pushComment(arr, 'a')
    pushComment(arr, 'b')
    expect(findComment(arr, 'missing')).toBeNull()
  })

  it('returns null on an empty array', () => {
    const ydoc = new Y.Doc()
    const arr = ydoc.getArray<Y.Map<unknown>>('comments')
    expect(findComment(arr, 'anything')).toBeNull()
  })

  it('finds the entry by id regardless of position', () => {
    const ydoc = new Y.Doc()
    const arr = ydoc.getArray<Y.Map<unknown>>('comments')
    pushComment(arr, 'a')
    pushComment(arr, 'b')
    pushComment(arr, 'target')
    pushComment(arr, 'c')
    const hit = findComment(arr, 'target')
    expect(hit?.index).toBe(2)
    expect(hit?.map.get('id')).toBe('target')
  })

  it('returns the FIRST match if duplicate ids somehow appear', () => {
    // Y.js doesn't enforce id uniqueness in an array; clients do via
    // nanoid. If a bug ever produced duplicates, we want the lookup
    // to be stable (first match) rather than randomly racing.
    const ydoc = new Y.Doc()
    const arr = ydoc.getArray<Y.Map<unknown>>('comments')
    pushComment(arr, 'dup', { body: 'first' })
    pushComment(arr, 'dup', { body: 'second' })
    const hit = findComment(arr, 'dup')
    expect(hit?.index).toBe(0)
    expect(hit?.map.get('body')).toBe('first')
  })
})

describe('readCommentAuthor', () => {
  it('returns the numeric authorId and the authorName when both are present', () => {
    const ydoc = new Y.Doc()
    const arr = ydoc.getArray<Y.Map<unknown>>('comments')
    const map = pushComment(arr, 'c', { authorId: 42, authorName: 'Alice' })
    expect(readCommentAuthor(map)).toEqual({ authorId: 42, authorName: 'Alice' })
  })

  it('returns authorId null for an anonymous comment', () => {
    // Anonymous editors store `authorId: null` and a session-random
    // name. The server can't author-authorise these — only doc
    // owners / workspace admins can delete.
    const ydoc = new Y.Doc()
    const arr = ydoc.getArray<Y.Map<unknown>>('comments')
    const map = pushComment(arr, 'c', { authorId: null, authorName: 'Lively Bear' })
    expect(readCommentAuthor(map)).toEqual({ authorId: null, authorName: 'Lively Bear' })
  })

  it('coerces a non-number authorId to null', () => {
    // Defensive: a malformed Y.Map (e.g. authorId stored as a string
    // by an older client) shouldn't grant impersonation rights — we
    // refuse to treat it as a match.
    const ydoc = new Y.Doc()
    const arr = ydoc.getArray<Y.Map<unknown>>('comments')
    const map = new Y.Map<unknown>()
    arr.push([map])
    map.set('authorId', '99')
    map.set('authorName', 'Alice')
    expect(readCommentAuthor(map).authorId).toBeNull()
  })

  it('returns an empty authorName when the field is missing or wrong type', () => {
    const ydoc = new Y.Doc()
    const arr = ydoc.getArray<Y.Map<unknown>>('comments')
    const map = new Y.Map<unknown>()
    arr.push([map])
    map.set('id', 'c')
    // No authorName at all — readCommentAuthor must default safely.
    expect(readCommentAuthor(map)).toEqual({ authorId: null, authorName: '' })
  })
})

describe('readReplyAuthor', () => {
  function buildRoot(fixture: Array<{ id: string, authorId?: number | null, authorName?: string }>): { ydoc: Y.Doc, root: Y.Map<unknown> } {
    const ydoc = new Y.Doc()
    const arr = ydoc.getArray<Y.Map<unknown>>('comments')
    const root = pushComment(arr, 'root')
    for (const r of fixture) {
      pushReply(root, r.id, { authorId: r.authorId ?? null, authorName: r.authorName ?? 'Anon' })
    }
    return { ydoc, root }
  }

  it('finds the reply by id and returns its author', () => {
    const { root } = buildRoot([
      { id: 'r1', authorId: 1, authorName: 'Alice' },
      { id: 'r2', authorId: 2, authorName: 'Bob' }
    ])
    const hit = readReplyAuthor(root, 'r2')
    expect(hit?.index).toBe(1)
    expect(hit?.author).toEqual({ authorId: 2, authorName: 'Bob' })
  })

  it('returns null when the reply id is not present', () => {
    const { root } = buildRoot([{ id: 'r1' }])
    expect(readReplyAuthor(root, 'missing')).toBeNull()
  })

  it('returns null when the parent has no replies array', () => {
    // A malformed/old comment without a `replies` Y.Array shouldn't
    // crash the lookup — server returns "alreadyGone" idempotency.
    const ydoc = new Y.Doc()
    const arr = ydoc.getArray<Y.Map<unknown>>('comments')
    const map = new Y.Map<unknown>()
    arr.push([map])
    map.set('id', 'root')
    expect(readReplyAuthor(map, 'r1')).toBeNull()
  })

  it('exposes the repliesArr handle for the caller to mutate', () => {
    // The helper returns the Y.Array reference so the delete endpoint
    // can call .delete(index, 1) on it inside a transaction. Verify
    // the handle is the same instance the parent map holds.
    const { root } = buildRoot([{ id: 'r1' }])
    const hit = readReplyAuthor(root, 'r1')
    expect(hit?.repliesArr).toBe(root.get('replies'))
  })
})
