import type { H3Event } from 'h3'
import { getDoc } from '../../../repos/documents'
import type { DocAccess, UserScope } from '../../../repos/proofs'
import { buildKnowledgeBlock, buildWorkspaceMembersBlock, withKnowledgeNote } from '../workspacePromptBlocks'
import { buildCommentTriggerBlock, resolveCommentTrigger, COMMENT_TRIGGER_SYSTEM_PROMPT } from '../commentTriggerPrompt'
import { assemblePromptSystemPrompt } from '../promptAssembly'
import { openTrustedCommentClient } from '../../documents/commentsServerClient'
import { wrapPromptWithEditorState } from '../editorStatePrompt'
import { EDITOR_SELECTION_TEXT_MAX } from '~~/shared/types/editorSelection'
import { apiError } from '../../api/apiError'
import { useLogger } from '../../platform/logger'
import { documentContextBlockFor, openAiSession, resolveSessionWorkspace, type SessionWorkspace } from './sessionSetup'
import { runAgentSession } from './runSession'

const log = useLogger('ai-trigger')

// An AI session seeded with one comment thread
// (`POST /api/docs/:docId/comments/:commentId/trigger-ai`, a comment or
// reply mentioning `@ai`). Identical to an editor prompt except:
//
//   1. The system prompt is the comment-trigger flavour
//      (`commentTriggerPrompt.ts`): instructs the model to end with
//      reply_to_comment on the trigger thread, never to create_comment,
//      never to resolve unless asked.
//   2. The seed user-message is the `<comment_trigger>` block (the
//      thread as quoted data) followed by the triggering message body
//      with @ai mentions stripped.
//   3. Awareness `aiSession` includes a `commentThreadId` so all
//      clients can render a per-thread "AI is working" indicator.

export interface CommentTriggerRequest {
  /** The route's write proof for the document (`allow.doc('write-content')`). */
  docAccess: DocAccess<'write'>
  self: UserScope
  commentId: string
  replyId: string | null
  user: { id: number, name: string }
}

export async function startCommentTrigger(event: H3Event, request: CommentTriggerRequest): Promise<{ sessionId: string }> {
  const { docAccess, self, commentId } = request
  const docId = docAccess.docId
  const userId = request.user.id

  const doc = await getDoc(docAccess)
  const wsCtx = await resolveSessionWorkspace(doc?.workspaceId ?? null, userId)
  const triggerCtx = await peekTriggerThread(docId, userId, commentId, request.replyId)
  // The thread is written by whoever commented: it goes into the USER
  // message as quoted data, never into the system prompt.
  const wrappedSeedPrompt = triggerCtx.block + '\n' + wrapSeedWithEditorState(triggerCtx.seedPrompt, triggerCtx.thread)
  const systemPrompt = buildTriggerSystemPrompt(doc, wsCtx)

  // The (stripped) seed prompt goes to the initiator's channel; the trigger
  // thread id rides on awareness so the client can render a per-thread
  // highlight on the matching comment card.
  const session = await openAiSession(event, {
    docId,
    docAccess,
    self,
    userId,
    userName: request.user.name,
    workspaceId: wsCtx.workspaceId,
    channelPrompt: triggerCtx.seedPrompt.slice(0, 240),
    commentThreadId: commentId
  })

  void runAgentSession({
    docId,
    userId,
    docAccess,
    self,
    workspace: wsCtx,
    session,
    systemPrompt,
    initialPrompt: withKnowledgeNote(wrappedSeedPrompt, wsCtx.exposeKnowledgeTools),
    // The triggering message is the caller's own (checked in
    // `peekTriggerThread`); the rest of the thread may not be.
    invokerText: triggerCtx.seedPrompt,
    toolDeclarations: wsCtx.toolDeclarations,
    workspaceId: wsCtx.workspaceId,
    knowledgeFiles: wsCtx.knowledgeFiles,
    commentThreadId: commentId,
    extraInitialTaint: triggerCtx.threadHasOthers ? 'a comment thread with other participants' : null,
    log,
    failure: { component: 'aiCommentTrigger', fields: { sessionId: session.sessionId, docId, commentId } }
  })

  return { sessionId: session.sessionId }
}

interface TriggerCtx {
  thread: NonNullable<ReturnType<typeof resolveCommentTrigger>>
  block: string
  seedPrompt: string
  /** Someone other than the caller wrote part of the thread → the session starts tainted. */
  threadHasOthers: boolean
}

/**
 * Read the comment thread from the live Y.Doc to build the trigger
 * context BEFORE opening the (long-lived) AI session. Lighter than
 * running a full createAiSession just to peek at one thread.
 *
 * 404 is the right answer for "thread missing", "triggering message
 * was AI-authored (loop guard)", "triggering message isn't the caller's"
 * and "triggering message doesn't mention the AI". All surface to the
 * client, which quietly drops.
 *
 * Empty seed prompt (someone posted just `@ai`) is replaced with a
 * safe default so the model has something to react to and isn't stuck
 * staring at an empty prompt.
 */
async function peekTriggerThread(docId: string, userId: number, commentId: string, replyId: string | null): Promise<TriggerCtx> {
  const peek = await openTrustedCommentClient(docId, `comments-server:trigger:${userId}`)
  try {
    const ytext = peek.ydoc.getText('content')
    const thread = resolveCommentTrigger(peek.ydoc, ytext, commentId, replyId)
    // Comment authorship is client-written Y.js data, so this is not
    // proof: but it stops the endpoint from being pointed at somebody
    // else's message (or one that never asked for the AI).
    if (thread?.triggerAuthorId !== userId || !thread.triggerMentionsAi) {
      throw apiError('ai/comment-trigger-not-eligible')
    }
    let seedPrompt = thread.triggerBody
    if (seedPrompt.length === 0) {
      seedPrompt = 'Read the thread and the anchored text in <comment_trigger>, then take whatever action seems most useful and reply on the thread explaining what you did.'
    }
    const threadHasOthers = thread.parentAuthorId !== userId || thread.replies.some(r => r.authorId !== userId)
    return { thread, block: buildCommentTriggerBlock(thread), seedPrompt, threadHasOthers }
  } finally {
    await peek.destroy()
  }
}

/**
 * Synthesize an `<editor_state>` selection from the comment's anchor.
 * Without this the model treats the trigger as an unscoped prompt and
 * its routing rules ("kind: selection → replace_text on the selected
 * range") never fire: it falls back to `insert_text` at EOF for
 * "rewrite this" style requests. Orphaned anchors (no resolvable
 * range) pass through unwrapped; the model can still see the original
 * anchor text in the `<comment_trigger>` block.
 */
function wrapSeedWithEditorState(seedPrompt: string, thread: TriggerCtx['thread']): string {
  if (thread.startLine === null || thread.endLine === null || thread.anchorText === null) {
    return seedPrompt
  }
  const anchorText = thread.anchorText
  const cappedText = anchorText.length > EDITOR_SELECTION_TEXT_MAX + 1
    ? anchorText.slice(0, EDITOR_SELECTION_TEXT_MAX) + '…'
    : anchorText
  return wrapPromptWithEditorState(seedPrompt, {
    kind: 'selection',
    fromLine: thread.startLine,
    toLine: thread.endLine,
    text: cappedText,
    truncated: cappedText !== anchorText
  })
}

/**
 * Same shape as the editor prompt's system prompt but uses the
 * comment-trigger flavour SYSTEM_PROMPT (banishes create_comment,
 * forces reply_to_comment ending). The per-thread block is NOT part of
 * it: it rides in the user message as quoted data.
 */
function buildTriggerSystemPrompt(doc: Awaited<ReturnType<typeof getDoc>>, ws: SessionWorkspace): string {
  const documentContextBlock = documentContextBlockFor(doc)
  const knowledgeBlock = ws.exposeKnowledgeTools ? buildKnowledgeBlock(ws.knowledgeFiles) : ''
  const membersBlock = buildWorkspaceMembersBlock(ws.members)
  // Static prompt FIRST (identical for every trigger session), per-doc /
  // per-workspace context after it, so the cacheable prefix is shared; see
  // `agentic/promptAssembly.ts`.
  return assemblePromptSystemPrompt(COMMENT_TRIGGER_SYSTEM_PROMPT, { documentContextBlock, knowledgeBlock, membersBlock })
}
