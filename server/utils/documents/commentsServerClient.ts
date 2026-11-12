import { readYComment } from '~~/shared/utils/documents/yComment'
import * as Y from 'yjs'
import jwt from 'jsonwebtoken'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { Awareness } from 'y-protocols/awareness'
import type { SessionJwtPayload } from '~~/shared/contracts/jwt'
import { useEnv } from '~~/shared/env/load'

// Minimal trusted-client helper for server-side comment mutations.
//
// Mirrors `aiClient.ts` but without awareness/billing — we connect just
// long enough to (a) read the comments Y.Array entry to validate the
// caller's authorship, and (b) mutate it. The connection broadcasts
// the change live to every editor of the doc, so the UI updates in the
// same frame as the REST response.
//
// Why connect-and-disconnect rather than mutating Postgres directly:
// the live broadcast is the only way collaborators see the deletion
// without a manual refresh. Skipping Hocuspocus would leave editors
// with a stale comments list until their next sync.

export interface TrustedClient {
  ydoc: Y.Doc
  ycomments: Y.Array<Y.Map<unknown>>
  destroy(): Promise<void>
}

const SYNC_TIMEOUT_MS = 10_000

/**
 * Open a transient Hocuspocus client. Throws on auth/sync failure.
 * Caller MUST call `destroy()` when finished.
 *
 * `actorPrincipal` ends up in the Hocuspocus activity log via the
 * userId field — pass `comments-server:<verb>:<userId>` so audit can
 * tell server-driven mutations apart from regular edits.
 */
export async function openTrustedCommentClient(
  docId: string,
  actorPrincipal: string
): Promise<TrustedClient> {
  const env = useEnv()
  if (!env.auth.jwtSecret) throw new Error('jwtSecret not configured')

  const payload = {
    docId,
    userId: actorPrincipal,
    userName: 'Comments Service',
    readOnly: false
  } satisfies SessionJwtPayload
  const token = jwt.sign(payload, env.auth.jwtSecret, { expiresIn: '5m' })

  const ydoc = new Y.Doc()
  const awareness = new Awareness(ydoc)

  const wsUrl = env.sync.internalUrl.replace(/^http(s?):\/\//, 'ws$1://')

  let resolved = false
  let resolveSync!: () => void
  let rejectSync!: (e: Error) => void
  const syncReady = new Promise<void>((resolve, reject) => {
    resolveSync = resolve
    rejectSync = reject
  })
  const timer = setTimeout(() => {
    if (!resolved) {
      resolved = true
      rejectSync(new Error('Sync timeout'))
    }
  }, SYNC_TIMEOUT_MS)

  const provider = new HocuspocusProvider({
    url: wsUrl,
    name: docId,
    document: ydoc,
    awareness,
    token,
    onSynced: () => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      resolveSync()
    },
    onAuthenticationFailed: (data) => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      rejectSync(new Error('Auth failed: ' + (data?.reason || 'unknown')))
    },
    onClose: (data) => {
      if (resolved) return
      const evt = (data as { event?: { code?: number, reason?: string } })?.event
      resolved = true
      clearTimeout(timer)
      rejectSync(new Error(`Connection closed: ${evt?.code} ${evt?.reason || ''}`))
    }
  })

  try {
    await syncReady
  } catch (e) {
    // Best-effort cleanup before rethrowing.
    try {
      provider.disconnect()
    } catch {
      /* best-effort cleanup */
    }
    try {
      provider.destroy()
    } catch {
      /* best-effort cleanup */
    }
    try {
      ydoc.destroy()
    } catch {
      /* best-effort cleanup */
    }
    throw e
  }

  const ycomments = ydoc.getArray<Y.Map<unknown>>('comments')

  const destroy = async () => {
    try {
      awareness.setLocalState(null)
    } catch {
      /* best-effort cleanup */
    }
    try {
      provider.disconnect()
    } catch {
      /* best-effort cleanup */
    }
    try {
      provider.destroy()
    } catch {
      /* best-effort cleanup */
    }
    try {
      ydoc.destroy()
    } catch {
      /* best-effort cleanup */
    }
  }

  return { ydoc, ycomments, destroy }
}

/**
 * Locate a comment by id. Returns the index + map, or null if not found.
 */
export function findComment(
  ycomments: Y.Array<Y.Map<unknown>>,
  commentId: string
): { index: number, map: Y.Map<unknown> } | null {
  for (let i = 0; i < ycomments.length; i++) {
    const m = ycomments.get(i)
    if (m instanceof Y.Map && m.get('id') === commentId) {
      return { index: i, map: m }
    }
  }
  return null
}

export interface CommentAuthorRef {
  authorId: number | null
  authorName: string
}

export function readCommentAuthor(map: Y.Map<unknown>): CommentAuthorRef {
  const c = readYComment(map)
  return { authorId: c.authorId, authorName: c.authorName ?? '' }
}

export function readReplyAuthor(
  commentMap: Y.Map<unknown>,
  replyId: string
): { repliesArr: Y.Array<Y.Map<unknown>>, index: number, author: CommentAuthorRef } | null {
  const repliesArr = commentMap.get('replies')
  if (!(repliesArr instanceof Y.Array)) return null
  for (let i = 0; i < repliesArr.length; i++) {
    const r = repliesArr.get(i)
    if (r instanceof Y.Map && r.get('id') === replyId) {
      return {
        // `replies` holds one Y.Map per reply (the comments writers' layout).
        repliesArr: repliesArr as Y.Array<Y.Map<unknown>>,
        index: i,
        author: readCommentAuthor(r)
      }
    }
  }
  return null
}
