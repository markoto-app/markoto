import { nanoid } from 'nanoid'
import * as Sentry from '@sentry/nuxt'
import { findUserNameById } from '../../../../../repos/users'
import { getDoc } from '../../../../../repos/documents'
import { getMemberRole, listMembers } from '../../../../../repos/workspaceMembers'
import { listReadyKnowledgeBrief } from '../../../../../repos/knowledge'
import { addAiSession, removeAiSession, DuplicateSessionError } from '../../../../../utils/aiSessions'
import { createAiSession } from '../../../../../utils/aiClient'
import { resolveBillingContext } from '../../../../../utils/billing'
import { requireAiProviders } from '../../../../../utils/aiProviders/guard'
import type { ResolvedAiProviders } from '../../../../../utils/aiProviders/resolve'
import { runAgenticLoop } from '../../../../../utils/agentic/runLoop'
import { ALL_TOOL_DECLARATIONS, KNOWLEDGE_TOOL_DECLARATIONS } from '../../../../../utils/agentic/functionTools'
import { buildDocumentContext } from '../../../../../utils/agentic/documentContextPrompt'
import { buildKnowledgeBlock, buildWorkspaceMembersBlock } from '../../../../../utils/agentic/workspacePromptBlocks'
import { AiSessionChannel } from '../../../../../utils/agentic/sessionChannel'
import { buildSessionGuard } from '../../../../../utils/agentic/sessionGuard'
import type { CrossBoundaryGuard } from '../../../../../utils/agentic/crossBoundary'
import { finalizeSessionProvenance, recordSessionProvenance } from '../../../../../utils/agentic/sessionProvenance'
import {
  buildCommentTriggerBlock,
  resolveCommentTrigger,
  COMMENT_TRIGGER_SYSTEM_PROMPT
} from '../../../../../utils/agentic/commentTriggerPrompt'
import { openTrustedCommentClient } from '../../../../../utils/commentsServerClient'
import type { StreamStatusPhase } from '../../../../../utils/agentic/streamStatus'
import { wrapPromptWithEditorState } from '../../../../../utils/agentic/editorStatePrompt'
import { EDITOR_SELECTION_TEXT_MAX } from '~~/shared/types/editorSelection'

// POST /api/docs/:docId/comments/:commentId/trigger-ai
//
// Body: { replyId?: string }
//
// Spawns an AI agentic loop seeded with the contents of one comment
// thread. Used by the client when a user submits a comment or reply
// containing `@ai`. The session is identical to a regular /api/ai/prompt
// run except:
//
//   1. The system prompt is the comment-trigger flavour
//      (`commentTriggerPrompt.ts`) — instructs the model to end with
//      reply_to_comment on the trigger thread, never to create_comment,
//      never to resolve unless asked.
//   2. The seed user-message is the `<comment_trigger>` block (the
//      thread as quoted data) followed by the triggering message body
//      with @ai mentions stripped.
//   3. Awareness `aiSession` includes a `commentThreadId` so all
//      clients can render a per-thread "AI is working" indicator.
//
// Auth: requires login + doc-edit access (same as /api/ai/prompt;
// viewers can write comments but can't summon AI). The triggering
// message must be the CALLER's own and must mention the AI — nobody can
// start a session (on their own budget) seeded with someone else's
// message. Per-user-per-doc session cap still applies.

const HARD_DEADLINE_MS = 5 * 60_000

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id
  const userName = session.user.name

  // Phase 5: text loop runs through LiteLLM unconditionally. Secret
  // validator enforces NUXT_LITELLM_URL + NUXT_LITELLM_MASTER_KEY at boot.
  // Phase 6: app-side rate limit dropped — LiteLLM's per-user-virtual-key
  // rpm_limit is the single enforcement point now.
  const { docId, commentId, replyId } = await parseTriggerInputs(event)

  await requireDocEditAccess(docId, userId)

  const doc = await getDoc(docId)
  const wsCtx = await resolveWorkspaceContext(doc?.workspaceId ?? null, userId)
  const triggerCtx = await peekTriggerThread(docId, userId, commentId, replyId)
  // The thread is written by whoever commented: it goes into the USER
  // message as quoted data, never into the system prompt.
  const wrappedSeedPrompt = triggerCtx.block + '\n' + wrapSeedWithEditorState(triggerCtx.seedPrompt, triggerCtx.thread)
  const systemPrompt = buildTriggerSystemPrompt(doc, wsCtx)

  // Phase 6: budget enforcement is delegated to the LiteLLM proxy via the
  // virtual key. We still resolve the billing context here to pick the
  // right attribution and lazy-create the key if needed. Exhaustion
  // surfaces inside the runLoop's catch block (LitellmBudgetExhausted).
  const billingContext = await resolveBillingContext(userId, wsCtx.workspaceId)
  // BYOK: no chat provider → 409 `ai/provider-missing` (the client shows
  // the "Add your API key in Settings" call-to-action).
  const aiProviders = await requireAiProviders(userId, 'chat')
  const initiatorName = (await findUserNameById(userId)) || userName
  const initiatorColor = '#d97706'
  const sessionId = nanoid(12)
  const abortController = new AbortController()

  const req = event.node?.req
  req?.once?.('close', () => {
    if (!req.readableEnded) abortController.abort()
  })

  await claimAiSession({ sessionId, docId, userId, initiatorName, initiatorColor, abortController })
  const deadlineTimer = setTimeout(() => abortController.abort(), HARD_DEADLINE_MS)
  // Initiator-only channel (prompt, status text, answers, confirmations).
  const channel = new AiSessionChannel(sessionId)
  await channel.open({ initiatorUserId: userId, docId, prompt: triggerCtx.seedPrompt.slice(0, 240), commentThreadId: commentId })

  // Fire-and-forget. The trigger thread id rides on awareness so the
  // client can render a per-thread highlight on the matching comment
  // card; the (stripped) seed prompt goes to the initiator's channel.
  void runTriggerLoop({
    docId, commentId, sessionId, userId, initiatorName, initiatorColor, abortController, deadlineTimer,
    seedPrompt: triggerCtx.seedPrompt,
    wrappedSeedPrompt,
    systemPrompt,
    toolDeclarations: wsCtx.toolDeclarations,
    workspaceId: wsCtx.workspaceId,
    knowledgeFiles: wsCtx.knowledgeFiles,
    threadHasOthers: triggerCtx.threadHasOthers,
    channel,
    billingContext,
    aiProviders
  })

  return { sessionId, commentId, replyId }
})

interface TriggerInputs { docId: string, commentId: string, replyId: string | null }

async function parseTriggerInputs(event: Parameters<Parameters<typeof defineEventHandler>[0]>[0]): Promise<TriggerInputs> {
  const docId = requireDocId(event)
  const commentId = getRouterParam(event, 'commentId')
  if (!commentId || commentId.length === 0 || commentId.length > 64) {
    throw createError({ statusCode: 400, message: 'Invalid commentId' })
  }
  const body = await readBody(event)
  let replyId: string | null = null
  if (body && typeof body.replyId === 'string') {
    if (body.replyId.length === 0 || body.replyId.length > 64) {
      throw createError({ statusCode: 400, message: 'Invalid replyId' })
    }
    replyId = body.replyId
  }
  return { docId, commentId, replyId }
}

interface WorkspaceCtx {
  workspaceId: string | null
  knowledgeFiles: Awaited<ReturnType<typeof listReadyKnowledgeBrief>>
  members: Array<{ userId: number, name: string }>
  toolDeclarations: typeof ALL_TOOL_DECLARATIONS
  exposeKnowledgeTools: boolean
}

/**
 * Workspace + knowledge resolution — copied from /api/ai/prompt; the
 * trigger session has the same tool surface as a regular prompt. The
 * member-role re-check guards against mid-session demotion.
 */
async function resolveWorkspaceContext(rawWorkspaceId: string | null, userId: number): Promise<WorkspaceCtx> {
  if (!rawWorkspaceId) {
    return { workspaceId: null, knowledgeFiles: [], members: [], toolDeclarations: ALL_TOOL_DECLARATIONS, exposeKnowledgeTools: false }
  }
  const role = await getMemberRole(rawWorkspaceId, userId)
  if (role === null) {
    return { workspaceId: null, knowledgeFiles: [], members: [], toolDeclarations: ALL_TOOL_DECLARATIONS, exposeKnowledgeTools: false }
  }
  const [members, knowledgeFiles] = await Promise.all([
    listMembers(rawWorkspaceId),
    listReadyKnowledgeBrief(rawWorkspaceId)
  ])
  const exposeKnowledgeTools = knowledgeFiles.length > 0
  return {
    workspaceId: rawWorkspaceId,
    knowledgeFiles,
    members: members.map(m => ({ userId: m.userId, name: m.name })),
    toolDeclarations: exposeKnowledgeTools
      ? [...ALL_TOOL_DECLARATIONS, ...KNOWLEDGE_TOOL_DECLARATIONS]
      : ALL_TOOL_DECLARATIONS,
    exposeKnowledgeTools
  }
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
    // proof — but it stops the endpoint from being pointed at somebody
    // else's message (or one that never asked for the AI).
    if (thread?.triggerAuthorId !== userId || !thread.triggerMentionsAi) {
      throw createError({ statusCode: 404, message: 'Comment thread not found or not eligible to trigger AI.' })
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
 * range") never fire — it falls back to `insert_text` at EOF for
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
 * Same shape as /api/ai/prompt's system prompt build but uses the
 * comment-trigger flavour SYSTEM_PROMPT (banishes create_comment,
 * forces reply_to_comment ending). The per-thread block is NOT part of
 * it — it rides in the user message as quoted data.
 */
function buildTriggerSystemPrompt(
  doc: Awaited<ReturnType<typeof getDoc>>,
  ws: WorkspaceCtx
): string {
  const documentContextBlock = doc
    ? buildDocumentContext({
        title: doc.title,
        description: doc.description,
        audience: doc.audience,
        language: doc.language
      })
    : ''
  const knowledgeBlock = ws.exposeKnowledgeTools ? buildKnowledgeBlock(ws.knowledgeFiles) : ''
  const membersBlock = buildWorkspaceMembersBlock(ws.members)
  return documentContextBlock + COMMENT_TRIGGER_SYSTEM_PROMPT + knowledgeBlock + membersBlock
}

interface ClaimSessionArgs {
  sessionId: string
  docId: string
  userId: number
  initiatorName: string
  initiatorColor: string
  abortController: AbortController
}

async function claimAiSession(args: ClaimSessionArgs): Promise<void> {
  try {
    await addAiSession({
      sessionId: args.sessionId,
      docId: args.docId,
      initiatorUserId: args.userId,
      initiatorName: args.initiatorName,
      initiatorColor: args.initiatorColor,
      abortController: args.abortController,
      startedAt: new Date()
    })
  } catch (e) {
    if (e instanceof DuplicateSessionError) {
      throw createError({
        statusCode: 409,
        message: 'You already have an AI session running on this document.',
        data: { code: 'ai/duplicate-session', messageKey: 'ai.errors.duplicateSession' }
      })
    }
    throw e
  }
  // Provenance row BEFORE the AI client can write (taint gate, see
  // `sessionProvenance.ts`). Releases the session again on failure.
  await recordSessionProvenance(args.sessionId, args.docId, args.userId)
}

interface TriggerLoopArgs {
  docId: string
  commentId: string
  sessionId: string
  userId: number
  initiatorName: string
  initiatorColor: string
  abortController: AbortController
  deadlineTimer: ReturnType<typeof setTimeout>
  seedPrompt: string
  wrappedSeedPrompt: string
  systemPrompt: string
  toolDeclarations: typeof ALL_TOOL_DECLARATIONS
  workspaceId: string | null
  knowledgeFiles: WorkspaceCtx['knowledgeFiles']
  threadHasOthers: boolean
  channel: AiSessionChannel
  billingContext: Awaited<ReturnType<typeof resolveBillingContext>>
  aiProviders: ResolvedAiProviders
}

async function runTriggerLoop(args: TriggerLoopArgs): Promise<void> {
  let aiSession: Awaited<ReturnType<typeof createAiSession>> | null = null
  let crossBoundary: CrossBoundaryGuard | null = null
  const status: { phase: StreamStatusPhase } = { phase: 'thinking' }
  const setStatus = (phase: StreamStatusPhase, message?: string) => {
    status.phase = phase
    if (aiSession) aiSession.updateStatus(phase, message)
    else void args.channel.setStatus({ phase, message: message ?? null })
  }

  try {
    aiSession = await createAiSession(args.docId, {
      sessionId: args.sessionId,
      initiatorName: args.initiatorName,
      initiatorUserId: args.userId,
      initiatorColor: args.initiatorColor,
      channel: args.channel,
      workspaceId: args.workspaceId,
      attributedTo: args.billingContext.attributedTo,
      plan: args.billingContext.plan,
      periodStart: args.billingContext.periodStart,
      virtualKey: args.billingContext.virtualKey,
      aiProviders: args.aiProviders,
      commentThreadId: args.commentId
    }, args.abortController.signal)

    // Taint gate. The triggering message is the caller's own (checked
    // above); the rest of the thread may not be.
    crossBoundary = await buildSessionGuard({
      docId: args.docId,
      initiatorUserId: args.userId,
      workspaceId: args.workspaceId,
      ydoc: aiSession.ydoc,
      channel: args.channel,
      invokerText: [args.seedPrompt],
      knowledgeFiles: args.knowledgeFiles,
      extraInitialTaint: args.threadHasOthers ? 'a comment thread with other participants' : null
    })

    await runAgenticLoop({
      // Production omits `ai` so runLoop routes through LiteLLM on the
      // session's resolved chat provider. `model` is test-seam-only.
      model: '',
      systemPrompt: args.systemPrompt,
      initialPrompt: args.wrappedSeedPrompt,
      toolDeclarations: args.toolDeclarations,
      thinkingBudget: 0,
      aiSession,
      sessionId: args.sessionId,
      abortController: args.abortController,
      setStatus,
      billingContext: args.billingContext,
      // Tells runLoop's salvage path to call `reply_to_comment`
      // instead of `message_to_user` when Mistral emits prose with
      // no tool call. Without this the comment thread looks ignored.
      commentThreadId: args.commentId,
      crossBoundary
    })
  } catch (e: unknown) {
    handleTriggerLoopError(e, args, setStatus)
  } finally {
    clearTimeout(args.deadlineTimer)
    const lingerMs = status.phase === 'error' ? 2500 : 500
    await new Promise(r => setTimeout(r, lingerMs))
    if (aiSession) await aiSession.destroy()
    // The AI has left the document: its edits count as the invoker's
    // own only if the session never read anybody else's content.
    await finalizeSessionProvenance(args.sessionId, crossBoundary)
    await removeAiSession(args.sessionId)
  }
}

function handleTriggerLoopError(
  e: unknown,
  args: TriggerLoopArgs,
  setStatus: (phase: StreamStatusPhase, message?: string) => void
): void {
  const err = e as { name?: string, message?: string }
  const isAbort
    = args.abortController.signal.aborted
      || err?.name === 'AbortError'
      || err?.message === 'aborted'
      || /abort/i.test(String(err?.message ?? ''))
  // Message → initiator only (session channel); others see the phase.
  setStatus(isAbort ? 'done' : 'error', isAbort ? 'Stopped' : `Error: ${err?.message ?? 'unknown'}`)
  if (isAbort) {
    console.log(`[ai/trigger ${args.sessionId}] aborted by user`)
  } else {
    console.error(`[ai/trigger ${args.sessionId}] loop failed:`, e)
    Sentry.captureException(e, {
      tags: { component: 'aiCommentTrigger', event: 'loop_failed', sessionId: args.sessionId, docId: args.docId, commentId: args.commentId }
    })
  }
}
