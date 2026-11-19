import * as Y from 'yjs'
import { openTrustedCommentClient, type TrustedClient } from '../documents/commentsServerClient'
import { flushSyncDocument } from '../documents/syncNotify'
import { appendActivity, pruneActivity } from '../../repos/activity'
import { latestYjsId } from '../../repos/yjsLog'
import type { DocAccess } from '../../repos/proofs'
import { applySuggestion, readSuggestions, suggestionsMap, type ResolvedSuggestion } from '~~/shared/utils/suggestions/ySuggestions'
import { suggestionAuthorKey, type SuggestionRecord } from '~~/shared/utils/suggestions/record'
import { suggestionsServerUserId } from '~~/shared/contracts/jwt'
import { useLogger } from '../platform/logger'

const log = useLogger('suggestions')

// Accepting and rejecting suggestions, server side.
//
// Accepting applies the change as an edit OF THE SUGGESTER: the text is
// changed by a short-lived sync client that connects with the suggester's
// own principal (their user id, `anonymous`, or the AI session / job /
// MCP session that suggested it), so the sync server's `edit` activity
// row and every later attribution name them, not the reviewer. The record
// is removed in the same Y.js transaction as the text change, so no
// client ever sees the change applied AND still suggested.
//
// The reviewer's own row (`suggestion.accepted` / `suggestion.rejected`)
// names who decided. Its yjs boundaries bracket the whole operation, so
// "Restore" on that row in the activity log undoes an accept.
//
// Replies to a suggestion live in a comment thread carrying its id; the
// thread is marked resolved when the suggestion is decided.

export type SuggestionAction = 'accept' | 'reject'

export interface SuggestionSelection {
  /** Only these suggestions (others are ignored). */
  ids?: readonly string[]
  /** Only this author's (`suggestionAuthorKey`: `user:<id>`, `anon:<seed>`, `ai`). */
  authorKey?: string
}

export interface ResolveSuggestionsInput {
  doc: DocAccess<'write'>
  reviewer: { userId: number, name: string }
  action: SuggestionAction
  select: SuggestionSelection
}

export interface ResolveSuggestionsResult {
  /** Suggestions accepted or rejected. */
  resolved: number
  /** Requested ids that no longer exist (someone else decided them). */
  missing: number
}

/** At most this many distinct authors per accept call (one connection each). */
export const MAX_AUTHORS_PER_ACCEPT = 20

function pick(all: readonly ResolvedSuggestion[], select: SuggestionSelection): ResolvedSuggestion[] {
  const ids = select.ids ? new Set(select.ids) : null
  return all.filter(s => (!ids || ids.has(s.record.id)) && (!select.authorKey || suggestionAuthorKey(s.record) === select.authorKey))
}

/** The principal a suggestion is applied as: its author. */
function authorPrincipal(r: SuggestionRecord): string {
  if (r.authorPrincipal !== null) return r.authorPrincipal
  return r.authorId !== null ? String(r.authorId) : 'anonymous'
}

function resolveThreads(client: TrustedClient, ids: ReadonlySet<string>): void {
  const now = Date.now()
  client.ydoc.transact(() => {
    for (let i = 0; i < client.ycomments.length; i++) {
      const m = client.ycomments.get(i)
      if (!(m instanceof Y.Map)) continue
      const sid = m.get('suggestionId')
      if (typeof sid === 'string' && ids.has(sid) && m.get('resolved') !== true) {
        m.set('resolved', true)
        m.set('updatedAt', now)
      }
    }
  }, 'suggestions')
}

async function withClient<T>(docId: string, principal: string, name: string, fn: (c: TrustedClient) => Promise<T>): Promise<T> {
  const client = await openTrustedCommentClient(docId, principal, name)
  try {
    return await fn(client)
  } finally {
    await client.destroy()
  }
}

/** Apply each author's suggestions as that author, one connection per author. */
async function acceptAsAuthors(docId: string, chosen: readonly ResolvedSuggestion[]): Promise<number> {
  const byAuthor = new Map<string, { name: string, ids: string[] }>()
  for (const s of chosen) {
    const principal = authorPrincipal(s.record)
    const group = byAuthor.get(principal) ?? { name: s.record.authorName, ids: [] }
    group.ids.push(s.record.id)
    byAuthor.set(principal, group)
  }
  if (byAuthor.size > MAX_AUTHORS_PER_ACCEPT) throw apiError('suggestion/too-many-authors', { max: MAX_AUTHORS_PER_ACCEPT })
  let applied = 0
  for (const [principal, group] of byAuthor) {
    applied += await withClient(docId, principal, group.name, async (c) => {
      let n = 0
      c.ydoc.transact(() => {
        // Back to front, so a suggestion's text never lands inside the
        // range of one applied after it.
        const live = readSuggestions(c.ydoc).filter(s => group.ids.includes(s.record.id)).reverse()
        for (const s of live) {
          applySuggestion(c.ydoc, s.record)
          n++
        }
      }, `suggestion-accept:${principal}`)
      await c.acknowledged()
      return n
    })
  }
  return applied
}

/** Accept or reject the selected suggestions and record who decided. */
export async function resolveSuggestions(input: ResolveSuggestionsInput): Promise<ResolveSuggestionsResult> {
  const { doc, reviewer, action, select } = input
  const docId = doc.docId
  const before = await latestYjsId(doc)
  const reviewerPrincipal = suggestionsServerUserId(action, reviewer.userId)

  // Read the current suggestions with the reviewer's principal; rejecting
  // happens on this connection, accepting on the authors' own.
  const chosen = await withClient(docId, reviewerPrincipal, reviewer.name, async (c) => {
    const selected = pick(readSuggestions(c.ydoc), select)
    if (action === 'reject' && selected.length > 0) {
      c.ydoc.transact(() => {
        const map = suggestionsMap(c.ydoc)
        for (const s of selected) map.delete(s.record.id)
      }, 'suggestions')
      await c.acknowledged()
    }
    return selected
  })
  const missing = select.ids ? select.ids.filter(id => !chosen.some(s => s.record.id === id)).length : 0
  if (chosen.length === 0) return { resolved: 0, missing }

  const resolved = action === 'accept' ? await acceptAsAuthors(docId, chosen) : chosen.length

  // Close the reply threads of what was decided.
  const ids = new Set(chosen.map(s => s.record.id))
  try {
    await withClient(docId, reviewerPrincipal, reviewer.name, async (c) => {
      resolveThreads(c, ids)
      await c.acknowledged()
    })
  } catch (e) {
    // The decision stands; an open thread is cosmetic.
    log.warn('could not resolve suggestion threads', { docId, err: e })
  }

  await flushSyncDocument(docId)
  const after = await latestYjsId(doc)
  const authors = [...new Set(chosen.map(s => s.record.authorName))].slice(0, 10)
  const first = chosen[0]?.record
  await appendActivity(doc, {
    userId: reviewer.userId,
    userName: reviewer.name,
    action: action === 'accept' ? 'suggestion.accepted' : 'suggestion.rejected',
    metadata: {
      kind: action === 'accept' ? 'suggestion.accepted' : 'suggestion.rejected',
      count: resolved,
      authors,
      preview: first ? suggestionPreview(first) : ''
    },
    yjsDocIdBefore: before,
    yjsDocIdAfter: after
  })
  await pruneActivity(doc)
  return { resolved, missing }
}

/** A short "struck -> inserted" line for the activity feed. */
export function suggestionPreview(r: Pick<SuggestionRecord, 'text' | 'deleted'>): string {
  const clip = (t: string) => {
    const one = t.replace(/\s+/g, ' ').trim()
    return one.length > 60 ? `${one.slice(0, 59)}…` : one
  }
  if (r.deleted && r.text) return `${clip(r.deleted)} → ${clip(r.text)}`
  return clip(r.text || r.deleted)
}
