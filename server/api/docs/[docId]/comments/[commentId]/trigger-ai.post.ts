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
  const config = useRuntimeConfig()

  // Phase 5: text loop runs through LiteLLM unconditionally. Secret
  // validator enforces NUXT_LITELLM_URL + NUXT_LITELLM_MASTER_KEY at boot.
  // Phase 6: app-side rate limit dropped (LiteLLM enforces rpm_limit
  // at the per-user-virtual-key level).
  if (false) {
    throw createError({
      statusCode: 429,
      message: 'Too many AI requests. Try again in a minute.',
      data: { code: 'ai/rate-limited', messageKey: 'error.rateLimited' }
    })
  }

  const docId = requireDocId(event)
  const commentId = getRouterParam(event, 'commentId')
  if (!commentId || commentId.length === 0 || commentId.length > 64) {
    throw createError({ statusCode: 400, message: 'Invalid commentId' })
  }

  const body = await readBody(event) as { replyId?: unknown }
  let replyId: string | null = null
  if (body && typeof body.replyId === 'string') {
    if (body.replyId.length === 0 || body.replyId.length > 64) {
      throw createError({ statusCode: 400, message: 'Invalid replyId' })
    }
    replyId = body.replyId
  }

  await requireDocEditAccess(docId, userId)

  // Workspace + knowledge resolution — copied from /api/ai/prompt; the
  // trigger session has the same tool surface as a regular prompt.
  let workspaceId: string | null = null
  let knowledgeFiles: Awaited<ReturnType<typeof listReadyKnowledgeBrief>> = []
  let workspaceMemberList: Array<{ userId: number, name: string }> = []
  const doc = await getDoc(docId)
  if (doc?.workspaceId) {
    const role = await getMemberRole(doc.workspaceId, userId)
    if (role !== null) {
      workspaceId = doc.workspaceId
      const [members, knowledge] = await Promise.all([
        listMembers(doc.workspaceId),
        listReadyKnowledgeBrief(doc.workspaceId)
      ])
      workspaceMemberList = members.map(m => ({ userId: m.userId, name: m.name }))
      knowledgeFiles = knowledge
    }
  }
  const exposeKnowledgeTools = workspaceId !== null && knowledgeFiles.length > 0
  const toolDeclarations = exposeKnowledgeTools
    ? [...ALL_TOOL_DECLARATIONS, ...KNOWLEDGE_TOOL_DECLARATIONS]
    : ALL_TOOL_DECLARATIONS

  // Read the comment thread from the live Y.Doc to build the trigger
  // context BEFORE we open the (long-lived) AI session. Lighter than
  // running a full createAiSession just to peek at one thread.
  const peek = await openTrustedCommentClient(docId, `comments-server:trigger:${userId}`)
  let block: string
  let seedPrompt: string
  let triggerThread: ReturnType<typeof resolveCommentTrigger>
  try {
    const ytext = peek.ydoc.getText('content')
    triggerThread = resolveCommentTrigger(peek.ydoc, ytext, commentId, replyId)
    if (!triggerThread) {
      // Either the comment doesn't exist (deleted between client write
      // and trigger fire) or the triggering message was AI-authored
      // (loop guard). Both surface as 404 — client can quietly drop.
      throw createError({ statusCode: 404, message: 'Comment thread not found or not eligible to trigger AI.' })
    }
    block = buildCommentTriggerBlock(triggerThread)
    seedPrompt = triggerThread.triggerBody
  } finally {
    await peek.destroy()
  }

  // Empty body after stripping `@ai` is rare but possible (someone
  // posted just "@ai"). Default to a safe seed so the model has
  // something to react to and isn't stuck staring at an empty prompt.
  if (seedPrompt.length === 0) {
    seedPrompt = 'Read the thread and the anchored text in <comment_trigger>, then take whatever action seems most useful and reply on the thread explaining what you did.'
  }

  // Synthesize an `<editor_state>` selection from the comment's anchor.
  // Without this the model treats the trigger as an unscoped prompt and
  // its routing rules ("kind: selection → replace_text on the selected
  // range") never fire, so it falls back to insert_text-at-EOF for
  // "rewrite this" style requests. The anchor IS the selection — feed
  // it through the same wrapper /api/ai/prompt uses for the selection
  // popup, so the existing routing rules in the system prompt take
  // over and steer the model toward replace_text.
  let wrappedSeedPrompt: string
  if (
    triggerThread.startLine !== null
    && triggerThread.endLine !== null
    && triggerThread.anchorText !== null
  ) {
    const anchorText = triggerThread.anchorText
    const cappedText = anchorText.length > EDITOR_SELECTION_TEXT_MAX + 1
      ? anchorText.slice(0, EDITOR_SELECTION_TEXT_MAX) + '…'
      : anchorText
    wrappedSeedPrompt = wrapPromptWithEditorState(seedPrompt, {
      kind: 'selection',
      fromLine: triggerThread.startLine,
      toLine: triggerThread.endLine,
      text: cappedText,
      truncated: cappedText !== anchorText
    })
  } else {
    // Orphaned anchor — no selection to wrap. Pass through unwrapped;
    // the system prompt's "kind: none" branch tells the model to act
    // on content alone (it can still see the original anchor text in
    // the <comment_trigger> block).
    wrappedSeedPrompt = seedPrompt
  }

  // System-prompt build — same shape as /api/ai/prompt but uses the
  // comment-trigger flavour SYSTEM_PROMPT (banishes create_comment,
  // forces reply_to_comment ending) and prepends the per-thread block
  // BEFORE the static system prompt so the model sees the trigger
  // context up front.
  const documentContextBlock = doc
    ? buildDocumentContext({
        title: doc.title,
        description: doc.description,
        audience: doc.audience,
        language: doc.language
      })
    : ''
  const knowledgeBlock = exposeKnowledgeTools
    ? buildKnowledgeBlockForTrigger(knowledgeFiles)
    : ''
  const membersBlock = workspaceMemberList.length > 0
    ? buildWorkspaceMembersBlockForTrigger(workspaceMemberList)
    : ''
  const systemPrompt = documentContextBlock + block + COMMENT_TRIGGER_SYSTEM_PROMPT + knowledgeBlock + membersBlock

  // Phase 6: budget enforcement is delegated to the LiteLLM proxy via the
  // virtual key. We still resolve the billing context here to pick the
  // right attribution and lazy-create the key if needed. Exhaustion
  // surfaces inside the runLoop's catch block (LitellmBudgetExhausted).
  const billingContext = await resolveBillingContext(userId, workspaceId)

  const initiatorName = (await findUserNameById(userId)) || userName
  const initiatorColor = '#d97706'

  const sessionId = nanoid(12)
  const abortController = new AbortController()

  const req = event.node?.req
  if (req) {
    req.once('close', () => {
      if (!req.readableEnded) abortController.abort()
    })
  }

  try {
    await addAiSession({
      sessionId,
      docId,
      initiatorUserId: userId,
      initiatorName,
      initiatorColor,
      abortController,
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

  const deadlineTimer = setTimeout(() => abortController.abort(), HARD_DEADLINE_MS)

  // The trigger thread id rides on awareness so the client can render
  // a per-thread highlight on the matching comment card. Keep the
  // initiator's prompt visible in the prompt-bar tooltip too — using
  // the (stripped) seed prompt is the most informative thing we have.
  void (async () => {
    let aiSession: Awaited<ReturnType<typeof createAiSession>> | null = null
    const status: { phase: StreamStatusPhase } = { phase: 'thinking' }
    const setStatus = (phase: StreamStatusPhase, message?: string) => {
      status.phase = phase
      aiSession?.updateStatus(phase, message)
    }

    try {
      aiSession = await createAiSession(docId, {
        sessionId,
        initiatorName,
        initiatorUserId: userId,
        initiatorColor,
        prompt: seedPrompt.slice(0, 240),
        workspaceId,
        attributedTo: billingContext.attributedTo,
        plan: billingContext.plan,
        periodStart: billingContext.periodStart,
        virtualKey: billingContext.virtualKey,
        commentThreadId: commentId
      }, abortController.signal)

      await runAgenticLoop({
        // Production omits `ai` so runLoop routes through LiteLLM →
        // Mistral. `model` is also test-seam-only — LiteLLM resolves
        // its own model from `config.litellm.textModel`.
        model: '',
        systemPrompt,
        initialPrompt: wrappedSeedPrompt,
        toolDeclarations,
        thinkingBudget: 0,
        aiSession,
        sessionId,
        abortController,
        setStatus,
        billingContext,
        // Tells runLoop's salvage path to call `reply_to_comment`
        // instead of `message_to_user` when Mistral emits prose with
        // no tool call. Without this the comment thread looks ignored.
        commentThreadId: commentId
      })
    } catch (e: unknown) {
      const err = e as { name?: string, message?: string }
      const isAbort
        = abortController.signal.aborted
          || err?.name === 'AbortError'
          || err?.message === 'aborted'
          || /abort/i.test(String(err?.message ?? ''))
      if (aiSession) {
        setStatus(isAbort ? 'done' : 'error', isAbort ? 'Stopped' : `Error: ${err?.message ?? 'unknown'}`)
      }
      if (!isAbort) {
        console.error(`[ai/trigger ${sessionId}] loop failed:`, e)
        Sentry.captureException(e, {
          tags: { component: 'aiCommentTrigger', event: 'loop_failed', sessionId, docId, commentId }
        })
      } else {
        console.log(`[ai/trigger ${sessionId}] aborted by user`)
      }
    } finally {
      clearTimeout(deadlineTimer)
      const lingerMs = status.phase === 'error' ? 2500 : 500
      await new Promise(r => setTimeout(r, lingerMs))
      if (aiSession) await aiSession.destroy()
      await removeAiSession(sessionId)
    }
  })()

  return { sessionId, commentId, replyId }
})

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
