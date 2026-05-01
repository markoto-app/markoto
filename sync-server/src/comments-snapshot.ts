// Mirrors the doc's `comments` Y.Array to the app's Postgres mirror
// table on every persisted save. Fire-and-forget — a failed snapshot
// never blocks Y.js sync; the mirror is eventually-consistent by design
// (see schema.ts comments on `document_comments`).

import * as Y from 'yjs'
import { injectTraceHeaders } from './sentry'

const APP_URL = process.env.APP_URL
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET

interface SnapshotEntry {
  entryId: string
  parentCommentId: string | null
  authorId: number | null
  authorName: string
  body: string
  createdAt: number
  updatedAt: number
  resolved: boolean
}

/**
 * Walk the doc's `comments` Y.Array and derive a flat list of
 * snapshot entries (root + nested replies). Replies inherit
 * `parentCommentId` from their thread root.
 */
function deriveSnapshot(ydoc: Y.Doc): SnapshotEntry[] {
  const ycomments = ydoc.getArray<Y.Map<unknown>>('comments')
  const out: SnapshotEntry[] = []
  for (let i = 0; i < ycomments.length; i++) {
    const map = ycomments.get(i)
    if (!(map instanceof Y.Map)) continue
    const id = map.get('id')
    if (typeof id !== 'string') continue
    const authorId = map.get('authorId')
    const authorName = map.get('authorName')
    const body = map.get('body')
    const createdAt = map.get('createdAt')
    const updatedAt = map.get('updatedAt')
    out.push({
      entryId: id,
      parentCommentId: null,
      authorId: typeof authorId === 'number' ? authorId : null,
      authorName: typeof authorName === 'string' ? authorName : 'Anonymous',
      body: typeof body === 'string' ? body : '',
      createdAt: typeof createdAt === 'number' ? createdAt : 0,
      updatedAt: typeof updatedAt === 'number' ? updatedAt : 0,
      resolved: Boolean(map.get('resolved'))
    })

    const repliesArr = map.get('replies')
    if (repliesArr instanceof Y.Array) {
      for (let j = 0; j < repliesArr.length; j++) {
        const r = repliesArr.get(j)
        if (!(r instanceof Y.Map)) continue
        const rid = r.get('id')
        if (typeof rid !== 'string') continue
        const rAuthorId = r.get('authorId')
        const rAuthorName = r.get('authorName')
        const rBody = r.get('body')
        const rCreatedAt = r.get('createdAt')
        const rUpdatedAt = r.get('updatedAt')
        out.push({
          entryId: rid,
          parentCommentId: id,
          authorId: typeof rAuthorId === 'number' ? rAuthorId : null,
          authorName: typeof rAuthorName === 'string' ? rAuthorName : 'Anonymous',
          body: typeof rBody === 'string' ? rBody : '',
          createdAt: typeof rCreatedAt === 'number' ? rCreatedAt : 0,
          updatedAt: typeof rUpdatedAt === 'number' ? rUpdatedAt : 0,
          resolved: false // replies inherit thread state via parentCommentId; column is for the root
        })
      }
    }
  }
  return out
}

/**
 * Per-doc dedup. We compare the freshly-derived snapshot to the last
 * one we shipped; if identical, we skip the round-trip entirely. Most
 * Y.js stores are content-only and don't touch the comments array, so
 * the dedup wipes out the vast majority of mirror calls.
 */
const lastShipped = new Map<string, string>()

/**
 * Best-effort. Errors are logged and swallowed; the mirror catches up
 * on the next store. Caller passes the Y.Doc directly so we don't have
 * to re-fetch it from y-postgresql.
 *
 * Optional `boundaries` carry the y-postgresql row ids around the
 * triggering store event — passed through so the comment.* activity
 * rows get the same diff-replay anchors as edit rows.
 */
export async function shipCommentsSnapshot(
  docId: string,
  ydoc: Y.Doc,
  boundaries?: { yjsDocIdBefore: number | null, yjsDocIdAfter: number | null }
): Promise<void> {
  if (!APP_URL || !INTERNAL_SECRET) return // dev setups can run without the mirror

  const entries = deriveSnapshot(ydoc)
  // Cheap content fingerprint — JSON.stringify of the small flat list
  // is fast enough at our scale (dozens-to-hundreds of comments).
  const fingerprint = JSON.stringify(entries)
  if (lastShipped.get(docId) === fingerprint) return

  try {
    const res = await fetch(`${APP_URL}/api/internal/comments-snapshot`, {
      method: 'POST',
      headers: injectTraceHeaders({
        'Content-Type': 'application/json',
        'X-Internal-Secret': INTERNAL_SECRET
      }),
      body: JSON.stringify({
        docId,
        entries,
        yjsDocIdBefore: boundaries?.yjsDocIdBefore ?? null,
        yjsDocIdAfter: boundaries?.yjsDocIdAfter ?? null
      }),
      signal: AbortSignal.timeout(8000)
    })
    if (res.ok) {
      lastShipped.set(docId, fingerprint)
    } else {
      console.warn(`[comments-snapshot] mirror returned ${res.status} for ${docId}`)
    }
  } catch (e) {
    console.warn(`[comments-snapshot] mirror failed for ${docId}:`, e instanceof Error ? e.message : e)
  }
}

/**
 * Drop the per-doc dedup cache. Call when the doc's last client
 * disconnects so we don't retain a fingerprint indefinitely.
 */
export function dropSnapshotCache(docId: string): void {
  lastShipped.delete(docId)
}
