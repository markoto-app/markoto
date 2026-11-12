import * as Y from 'yjs'
import { getDoc } from '../../repos/documents'
import { countOtherWorkspaceEditors, hasForeignContentActivity } from '../../repos/docProvenance'
import type { KnowledgeBrief } from '../../repos/knowledge'
import { accessibleDocTitle, parseDocIdFromInput } from '../ai/tools/crossDocumentTools'
import { CrossBoundaryGuard } from './crossBoundary'
import { proveDocMembership } from '../access/docProof'
import { proveWorkspaceAccess } from '../access/workspaceAccess'
import type { WorkspaceAccess } from '../../repos/proofs'
import type { AiSessionChannel } from './sessionChannel'
import { isAiCommentAuthor } from '~~/shared/ai/author'

// Wires the taint gate (`crossBoundary.ts`) to the real data sources for
// one loop session: document provenance, the live comments array, the
// session's knowledge files and the initiator-only confirmation channel.

/**
 * A document is "solo" for `userId` when only they can have shaped its
 * content: they own it, it isn't open for anyone to edit, nobody else
 * can edit in its workspace (admin / editor / guest with an edit share),
 * and every content change in its activity history is theirs (directly
 * or through their own AI / MCP / restore).
 * Anything else, including an unparseable or missing reference, is
 * treated as shared.
 */
async function isDocSoloForUser(docRef: string, userId: number): Promise<boolean> {
  const docId = parseDocIdFromInput(docRef)
  if (!docId) return false
  // Only an owner can have a solo document, and an owner has a membership
  // proof; without one (including an owner whose SSO grant lapsed) the
  // document counts as shared.
  const proven = await proveDocMembership(userId, docId, 'view')
  if (!proven) return false
  const doc = await getDoc(proven.access)
  if (doc?.ownerId !== userId) return false
  if (doc.accessMode === 'open-edit') return false
  if (doc.workspaceId) {
    const ws = await proveWorkspaceAccess(userId, doc.workspaceId, 'member')
    if (!ws || (await countOtherWorkspaceEditors(ws, userId)) > 0) return false
  }
  return !(await hasForeignContentActivity(proven.access, userId))
}

/**
 * Does the comments array hold anything not written by `userId`?
 * AI-named comments (no user id) are the invoker's own only on a solo
 * document: elsewhere anybody who can comment could have written one
 * under that name, so they count as foreign.
 */
export function commentsHaveForeignAuthors(ydoc: Y.Doc, userId: number, sessionDocSolo: boolean): boolean {
  const isOwn = (map: Y.Map<unknown>): boolean => {
    const authorId = map.get('authorId')
    if (authorId === userId) return true
    return sessionDocSolo && isAiCommentAuthor(authorId, map.get('authorName'))
  }
  const comments = ydoc.getArray<Y.Map<unknown>>('comments')
  for (let i = 0; i < comments.length; i++) {
    const m = comments.get(i)
    if (!(m instanceof Y.Map)) continue
    if (!isOwn(m)) return true
    const replies = m.get('replies')
    if (!(replies instanceof Y.Array)) continue
    for (let j = 0; j < replies.length; j++) {
      const r = replies.get(j)
      if (r instanceof Y.Map && !isOwn(r)) return true
    }
  }
  return false
}

export interface SessionGuardArgs {
  docId: string
  initiatorUserId: number
  /** Session workspace proof (null for standalone docs / non-members). */
  workspaceAccess: WorkspaceAccess<'member'> | null
  ydoc: Y.Doc
  channel: AiSessionChannel
  /** Text the initiator typed (prompt / their triggering comment). */
  invokerText: readonly string[]
  knowledgeFiles: readonly KnowledgeBrief[]
  /** Extra reason the session starts tainted (e.g. a comment thread with other participants). */
  extraInitialTaint?: string | null
}

export async function buildSessionGuard(args: SessionGuardArgs): Promise<CrossBoundaryGuard> {
  const sessionDocSolo = await isDocSoloForUser(args.docId, args.initiatorUserId)
  const initialTaint = sessionDocSolo ? (args.extraInitialTaint ?? null) : 'the shared document'
  const knowledgeFiles = new Map(args.knowledgeFiles.map(f => [
    f.knowledgeId,
    { filename: f.filename, foreign: f.uploaderId !== args.initiatorUserId }
  ]))
  return new CrossBoundaryGuard(
    { initialTaint, invokerText: args.invokerText, knowledgeFiles },
    {
      isDocSolo: ref => isDocSoloForUser(ref, args.initiatorUserId),
      describeDoc: ref => accessibleDocTitle(args.initiatorUserId, ref),
      commentsHaveForeignAuthors: () => commentsHaveForeignAuthors(args.ydoc, args.initiatorUserId, sessionDocSolo),
      workspaceHasOtherEditors: async () => args.workspaceAccess !== null && (await countOtherWorkspaceEditors(args.workspaceAccess, args.initiatorUserId)) > 0,
      confirm: (request, signal) => args.channel.requestConfirmation(request, signal)
    }
  )
}
