import { nanoid } from 'nanoid'
import * as Sentry from '@sentry/nuxt'
import { findUserNameById } from '../../../../../repos/users'
import { getDoc } from '../../../../../repos/documents'
import { getMemberRole, listMembers } from '../../../../../repos/workspaceMembers'
import { listReadyKnowledgeBrief } from '../../../../../repos/knowledge'
import { addAiSession, removeAiSession, DuplicateSessionError } from '../../../../../utils/aiSessions'
import { createAiSession } from '../../../../../utils/aiClient'
import { resolveBillingContext } from '../../../../../utils/billing'
import { runAgenticLoop } from '../../../../../utils/agentic/runLoop'
import { ALL_TOOL_DECLARATIONS, KNOWLEDGE_TOOL_DECLARATIONS } from '../../../../../utils/agentic/functionTools'
import { buildDocumentContext } from '../../../../../utils/agentic/documentContextPrompt'
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
//   1. The system prompt is the comment-trigger flavour (lives in
//      runLoop.ts as a sibling to SYSTEM_PROMPT) — instructs the model
//      to end with reply_to_comment on the trigger thread, never to
//      create_comment, never to resolve unless asked.
//   2. The seed user-message is the triggering message body with @ai
//      mentions stripped.
//   3. Awareness `aiSession` includes a `commentThreadId` so all
//      clients can render a per-thread "AI is working" indicator.
//
// Auth: requires login + doc-edit access (same as /api/ai/prompt;
// viewers can write comments but can't summon AI). Per-user-per-doc
// session cap still applies.

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
  const wrappedSeedPrompt = wrapSeedWithEditorState(triggerCtx.seedPrompt, triggerCtx.thread)
  const systemPrompt = buildTriggerSystemPrompt(doc, triggerCtx.block, wsCtx)

  // Phase 6: budget enforcement is delegated to the LiteLLM proxy via the
  // virtual key. We still resolve the billing context here to pick the
  // right attribution and lazy-create the key if needed. Exhaustion
  // surfaces inside the runLoop's catch block (LitellmBudgetExhausted).
  const billingContext = await resolveBillingContext(userId, wsCtx.workspaceId)
  const initiatorName = (await findUserNameById(userId)) || userName
  const initiatorColor = '#d97706'
  const sessionId = nanoid(12)
  const abortController = new AbortController()

  event.node?.req?.once?.('close', () => {
    if (!event.node!.req!.readableEnded) abortController.abort()
  })

  await claimAiSession({ sessionId, docId, userId, initiatorName, initiatorColor, abortController })
  const deadlineTimer = setTimeout(() => abortController.abort(), HARD_DEADLINE_MS)

  // Fire-and-forget. The trigger thread id rides on awareness so the
  // client can render a per-thread highlight on the matching comment
  // card. Keep the initiator's (stripped) seed prompt visible in the
  // prompt-bar tooltip — most informative thing we have.
  void runTriggerLoop({
    docId, commentId, sessionId, userId, initiatorName, initiatorColor, abortController, deadlineTimer,
    seedPrompt: triggerCtx.seedPrompt,
    wrappedSeedPrompt,
    systemPrompt,
    toolDeclarations: wsCtx.toolDeclarations,
    workspaceId: wsCtx.workspaceId,
    billingContext
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
}

/**
 * Read the comment thread from the live Y.Doc to build the trigger
 * context BEFORE opening the (long-lived) AI session. Lighter than
 * running a full createAiSession just to peek at one thread.
 *
 * 404 is the right answer for "thread missing OR triggering message
 * was AI-authored (loop guard)". Both surface to the client, which
 * quietly drops.
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
    if (!thread) {
      throw createError({ statusCode: 404, message: 'Comment thread not found or not eligible to trigger AI.' })
    }
    let seedPrompt = thread.triggerBody
    if (seedPrompt.length === 0) {
      seedPrompt = 'Read the thread and the anchored text in <comment_trigger>, then take whatever action seems most useful and reply on the thread explaining what you did.'
    }
    return { thread, block: buildCommentTriggerBlock(thread), seedPrompt }
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
 * forces reply_to_comment ending) and prepends the per-thread block
 * BEFORE the static system prompt so the model sees the trigger
 * context up front.
 */
function buildTriggerSystemPrompt(
  doc: Awaited<ReturnType<typeof getDoc>>,
  triggerBlock: string,
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
  const knowledgeBlock = ws.exposeKnowledgeTools ? buildKnowledgeBlockForTrigger(ws.knowledgeFiles) : ''
  const membersBlock = ws.members.length > 0 ? buildWorkspaceMembersBlockForTrigger(ws.members) : ''
  return documentContextBlock + triggerBlock + COMMENT_TRIGGER_SYSTEM_PROMPT + knowledgeBlock + membersBlock
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
  billingContext: Awaited<ReturnType<typeof resolveBillingContext>>
}

async function runTriggerLoop(args: TriggerLoopArgs): Promise<void> {
  let aiSession: Awaited<ReturnType<typeof createAiSession>> | null = null
  const status: { phase: StreamStatusPhase } = { phase: 'thinking' }
  const setStatus = (phase: StreamStatusPhase, message?: string) => {
    status.phase = phase
    aiSession?.updateStatus(phase, message)
  }

  try {
    aiSession = await createAiSession(args.docId, {
      sessionId: args.sessionId,
      initiatorName: args.initiatorName,
      initiatorUserId: args.userId,
      initiatorColor: args.initiatorColor,
      prompt: args.seedPrompt.slice(0, 240),
      workspaceId: args.workspaceId,
      attributedTo: args.billingContext.attributedTo,
      plan: args.billingContext.plan,
      periodStart: args.billingContext.periodStart,
      virtualKey: args.billingContext.virtualKey,
      commentThreadId: args.commentId
    }, args.abortController.signal)

    await runAgenticLoop({
      // Production omits `ai` so runLoop routes through LiteLLM →
      // Mistral. `model` is also test-seam-only — LiteLLM resolves
      // its own model from `config.litellm.textModel`.
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
      commentThreadId: args.commentId
    })
  } catch (e: unknown) {
    handleTriggerLoopError(e, args, aiSession, setStatus)
  } finally {
    clearTimeout(args.deadlineTimer)
    const lingerMs = status.phase === 'error' ? 2500 : 500
    await new Promise(r => setTimeout(r, lingerMs))
    if (aiSession) await aiSession.destroy()
    await removeAiSession(args.sessionId)
  }
}

function handleTriggerLoopError(
  e: unknown,
  args: TriggerLoopArgs,
  aiSession: Awaited<ReturnType<typeof createAiSession>> | null,
  setStatus: (phase: StreamStatusPhase, message?: string) => void
): void {
  const err = e as { name?: string, message?: string }
  const isAbort
    = args.abortController.signal.aborted
      || err?.name === 'AbortError'
      || err?.message === 'aborted'
      || /abort/i.test(String(err?.message ?? ''))
  if (aiSession) {
    setStatus(isAbort ? 'done' : 'error', isAbort ? 'Stopped' : `Error: ${err?.message ?? 'unknown'}`)
  }
  if (!isAbort) {
    console.error(`[ai/trigger ${args.sessionId}] loop failed:`, e)
    Sentry.captureException(e, {
      tags: { component: 'aiCommentTrigger', event: 'loop_failed', sessionId: args.sessionId, docId: args.docId, commentId: args.commentId }
    })
  } else {
    console.log(`[ai/trigger ${args.sessionId}] aborted by user`)
  }
}

// Local copies of the two block builders from /api/ai/prompt — kept
// inline to avoid an export ripple while the prompt endpoint and the
// trigger endpoint converge. Both functions are pure formatters; if
// they ever diverge (e.g. trigger needs different framing) we can
// keep the divergence local.

function buildKnowledgeBlockForTrigger(files: Array<{ knowledgeId: string, filename: string, sizeBytes: number, sourceExt: string, tokenCount: number }>): string {
  if (files.length === 0) return ''
  const lines = files.map((f) => {
    const kb = Math.max(1, Math.round(f.sizeBytes / 1024))
    return `- knowledge_id="${f.knowledgeId}" filename="${f.filename}" type=${f.sourceExt} size=${kb}KB tokens=${f.tokenCount}`
  })
  return (
    `\n\n<knowledge_files>\n`
    + `The user's workspace has the following uploaded knowledge files. Call \`search_knowledge\` to query across them, or \`get_knowledge_file\` with a specific knowledge_id when you need the full text. Only ids listed here are valid — do NOT invent or guess.\n\n`
    + `${lines.join('\n')}\n`
    + `</knowledge_files>`
  )
}

function buildWorkspaceMembersBlockForTrigger(members: Array<{ userId: number, name: string }>): string {
  if (members.length === 0) return ''
  const lines = members.map(m => `- user_id=${m.userId} name="${m.name}"`)
  return (
    `\n\n<workspace_members>\n`
    + `When mentioning teammates in comments, use @[Name](user:ID) with these user IDs:\n\n`
    + `${lines.join('\n')}\n`
    + `</workspace_members>`
  )
}
