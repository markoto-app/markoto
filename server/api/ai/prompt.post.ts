import { nanoid } from 'nanoid'
import * as Sentry from '@sentry/nuxt'
import { findUserNameById } from '../../repos/users'
import { getDoc } from '../../repos/documents'
import { getMemberRole, listMembers } from '../../repos/workspaceMembers'
import { listReadyKnowledgeBrief } from '../../repos/knowledge'
import { addAiSession, removeAiSession, DuplicateSessionError } from '../../utils/ai/aiSessions'
import { createAiSession } from '../../utils/ai/aiClient'
import { resolveBillingContext } from '../../utils/billing/billing'
import { requireAiProviders } from '../../utils/aiProviders/guard'
import { assertFreeAllowanceAvailable } from '../../utils/billing/freeAllowance'
import type { ResolvedAiProviders } from '../../utils/aiProviders/resolve'
import { runAgenticLoop } from '../../utils/agentic/runLoop'
import { ALL_TOOL_DECLARATIONS, KNOWLEDGE_TOOL_DECLARATIONS } from '../../utils/agentic/functionTools'
import {
  buildConversationContextForPrompt,
  shouldRecordToolInMemory,
  summarizeToolCall
} from '../../utils/agentic/conversationMemory'
import {
  appendAiMessage,
  lastActivityAt,
  loadRecentMessages
} from '../../repos/aiSessionMessages'
import type { StreamStatusPhase } from '../../utils/agentic/streamStatus'

import { validateEditorSelection, wrapPromptWithEditorState } from '../../utils/agentic/editorStatePrompt'
import { buildDocumentContext } from '../../utils/agentic/documentContextPrompt'
import { buildKnowledgeBlock, buildWorkspaceMembersBlock } from '../../utils/agentic/workspacePromptBlocks'
import { assemblePromptSystemPrompt, PROMPT_SYSTEM_PROMPT } from '../../utils/agentic/promptAssembly'
import { AiSessionChannel } from '../../utils/agentic/sessionChannel'
import { buildSessionGuard } from '../../utils/agentic/sessionGuard'
import type { CrossBoundaryGuard } from '../../utils/agentic/crossBoundary'
import { finalizeSessionProvenance, recordSessionProvenance } from '../../utils/agentic/sessionProvenance'
import { loopErrorMessage } from '../../utils/agentic/loopErrorMessage'

// Hard deadline for a full agentic loop. A grounded `web_search` sub-call can
// take several seconds; combined with model thinking and multi-edit sequences
// a realistic budget is several minutes. 5 min gives headroom while still
// killing truly stuck sessions. The per-user cap prevents runaway cost, and
// the sweeper (7 min — must remain ≥ this) is a safety net for abandoned
// sessions that skip the `finally` cleanup.
const HARD_DEADLINE_MS = 5 * 60_000

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id
  const userName = session.user.name

  // Phase 5: text loop runs through LiteLLM unconditionally. The secret
  // validator enforces NUXT_LITELLM_URL + NUXT_LITELLM_MASTER_KEY at boot.
  // Phase 6: app-side rate limit dropped — LiteLLM's per-user-virtual-key
  // rpm_limit is the single enforcement point now.
  const { docId, prompt, wrappedPrompt } = parsePromptInputs(await readBody(event))
  await requireDocEditAccess(docId, userId)

  const doc = await getDoc(docId)
  const wsCtx = await resolvePromptWorkspaceContext(doc?.workspaceId ?? null, userId)
  const documentContextBlock = doc
    ? buildDocumentContext({
        title: doc.title,
        description: doc.description,
        audience: doc.audience,
        language: doc.language
      })
    : ''
  const conversationBlock = await loadConversationBlock(docId, userId)
  // Ordered for prompt caching (see `agentic/promptAssembly.ts`): the
  // system message is static-first and carries only per-doc /
  // per-workspace context; the conversation memory changes with every
  // prompt, so it opens the first USER message (`promptPreamble`) instead
  // of closing the system message — where it invalidated the cached tool
  // definitions on Mistral Small (measured: 0 % → 99 % cached).
  const systemPrompt = assemblePromptSystemPrompt(PROMPT_SYSTEM_PROMPT, {
    documentContextBlock,
    knowledgeBlock: buildKnowledgeBlock(wsCtx.knowledgeFiles),
    membersBlock: buildWorkspaceMembersBlock(wsCtx.members)
  })

  // Resolve billing context up-front to lazy-create the LiteLLM virtual
  // key (if not already provisioned) and to pick the right attribution
  // (workspace `(+)` sponsor vs. self). Phase 6: app-side exhaustion
  // pre-check removed — the LiteLLM proxy enforces `max_budget` on the
  // first model call and the runLoop catches `LitellmBudgetExhausted` /
  // `isBudgetExceededError(...)` to surface the upgrade-CTA breadcrumb.
  const billingContext = await resolveBillingContext(userId, wsCtx.workspaceId)
  // BYOK: the user's own provider (or the instance default). No chat
  // provider → 409 `ai/provider-missing` with a link to the settings page.
  const aiProviders = await requireAiProviders(userId, 'chat', billingContext.plan)
  // Hosted free tier: the shared monthly pool may be used up — answer
  // 402 `ai/free-allowance-exhausted` before opening a session (own-key
  // users are never refused here).
  await assertFreeAllowanceAvailable(aiProviders.chat, billingContext.plan)

  const initiatorName = (await findUserNameById(userId)) || userName
  const initiatorColor = '#d97706' // Warm orange — reused from the original AI-as-collaborator design

  const sessionId = nanoid(12)
  const abortController = new AbortController()
  const req = event.node?.req
  req?.once?.('close', () => {
    if (!req.readableEnded) abortController.abort()
  })

  await claimAiSession({ sessionId, docId, userId, initiatorName, initiatorColor, abortController })
  const deadlineTimer = setTimeout(() => abortController.abort(), HARD_DEADLINE_MS)
  // Initiator-only channel: prompt, status text, answers, confirmations.
  // Opened before the response so the client's first poll finds it.
  const channel = new AiSessionChannel(sessionId)
  await channel.open({ initiatorUserId: userId, docId, prompt, commentThreadId: null })

  // Run in background — HTTP response returns immediately after registration.
  // All edits reach the client over Y.js; we don't need to stream anything on
  // this HTTP response. See server/utils/agentic/AGENTS.md for the full design.
  void runPromptLoop({
    docId, sessionId, userId, initiatorName, initiatorColor, abortController, deadlineTimer,
    prompt,
    wrappedPrompt,
    promptPreamble: conversationBlock,
    systemPrompt,
    toolDeclarations: wsCtx.toolDeclarations,
    workspaceId: wsCtx.workspaceId,
    knowledgeFiles: wsCtx.knowledgeFiles,
    channel,
    billingContext,
    aiProviders
  })

  return { sessionId }
})

interface PromptInputs { docId: string, prompt: string, wrappedPrompt: string }

/**
 * Validate body shape + the optional editor-state snapshot. Bad
 * snapshot shapes fall back to `kind: 'none'` rather than
 * hard-erroring — a stale / malformed snapshot shouldn't block a
 * request that would otherwise succeed.
 */
function parsePromptInputs(body: { docId?: unknown, prompt?: string, editorSelection?: unknown }): PromptInputs {
  const docId = body.docId
  const prompt = body.prompt?.trim()
  if (!docId || typeof docId !== 'string') throw createError({ statusCode: 400, message: 'Missing docId' })
  if (!prompt) throw createError({ statusCode: 400, message: 'Missing prompt' })
  if (prompt.length > 4000) throw createError({ statusCode: 400, message: 'Prompt too long (max 4000 chars)' })
  const editorSelection = validateEditorSelection(body.editorSelection)
  return { docId, prompt, wrappedPrompt: wrapPromptWithEditorState(prompt, editorSelection) }
}

interface PromptWorkspaceCtx {
  workspaceId: string | null
  knowledgeFiles: Awaited<ReturnType<typeof listReadyKnowledgeBrief>>
  members: Array<{ userId: number, name: string }>
  toolDeclarations: typeof ALL_TOOL_DECLARATIONS
}

/**
 * Knowledge-tool exposure rule: requires (a) the doc is in a workspace,
 * (b) the caller is a member, and (c) the workspace has at least one
 * ready knowledge file. Any missing condition → standard tool set.
 */
async function resolvePromptWorkspaceContext(rawWorkspaceId: string | null, userId: number): Promise<PromptWorkspaceCtx> {
  if (!rawWorkspaceId) return { workspaceId: null, knowledgeFiles: [], members: [], toolDeclarations: ALL_TOOL_DECLARATIONS }
  const role = await getMemberRole(rawWorkspaceId, userId)
  if (role === null) return { workspaceId: null, knowledgeFiles: [], members: [], toolDeclarations: ALL_TOOL_DECLARATIONS }
  const [members, knowledgeFiles] = await Promise.all([
    listMembers(rawWorkspaceId),
    listReadyKnowledgeBrief(rawWorkspaceId)
  ])
  const exposeKnowledgeTools = knowledgeFiles.length > 0
  return {
    workspaceId: rawWorkspaceId,
    knowledgeFiles,
    members: members.filter(m => m.role !== 'guest').map(m => ({ userId: m.userId, name: m.name })),
    toolDeclarations: exposeKnowledgeTools
      ? [...ALL_TOOL_DECLARATIONS, ...KNOWLEDGE_TOOL_DECLARATIONS]
      : ALL_TOOL_DECLARATIONS
  }
}

/**
 * Load conversation memory for THIS (doc, user) pair. The block is
 * empty when (a) no prior rows exist, or (b) the most recent row is
 * older than the idle gap (60 min) — both treated as a fresh start.
 * Failures degrade silently: a memory read hiccup mustn't block a
 * user-typed prompt; the loop just runs without prior context.
 */
async function loadConversationBlock(docId: string, userId: number): Promise<string> {
  try {
    const lastAt = await lastActivityAt(docId, userId)
    const ctx = await buildConversationContextForPrompt(
      since => loadRecentMessages(docId, userId, { since }),
      lastAt
    )
    return ctx.block
  } catch (e) {
    console.warn(`[ai/prompt] conversation memory load failed: ${e instanceof Error ? e.message : e}`)
    return ''
  }
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

interface PromptLoopArgs {
  docId: string
  sessionId: string
  userId: number
  initiatorName: string
  initiatorColor: string
  abortController: AbortController
  deadlineTimer: ReturnType<typeof setTimeout>
  prompt: string
  wrappedPrompt: string
  /** Per-prompt context (conversation memory) that opens the first user message. */
  promptPreamble: string
  systemPrompt: string
  toolDeclarations: typeof ALL_TOOL_DECLARATIONS
  workspaceId: string | null
  knowledgeFiles: PromptWorkspaceCtx['knowledgeFiles']
  channel: AiSessionChannel
  billingContext: Awaited<ReturnType<typeof resolveBillingContext>>
  aiProviders: ResolvedAiProviders
}

/**
 * Background fire-and-forget runner. The `status.phase` wrap (instead
 * of `let lastPhase: StreamStatusPhase`) is intentional — TS's
 * control-flow analysis would narrow a literal through try/catch and
 * reject the `finally` comparison with `'error'`.
 */
async function runPromptLoop(args: PromptLoopArgs): Promise<void> {
  let aiSession: Awaited<ReturnType<typeof createAiSession>> | null = null
  let crossBoundary: CrossBoundaryGuard | null = null
  const status: { phase: StreamStatusPhase } = { phase: 'thinking' }
  const setStatus = (phase: StreamStatusPhase, message?: string) => {
    status.phase = phase
    if (aiSession) aiSession.updateStatus(phase, message)
    else void args.channel.setStatus({ phase, message: message ?? null })
  }

  await recordUserPromptMemory(args)
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
      aiProviders: args.aiProviders
    }, args.abortController.signal)

    // Taint gate: a document other people edit (or later: their
    // comments, web pages, their knowledge files, other documents)
    // makes cross-document / knowledge / web tools ask the initiator
    // first. Only what the initiator typed counts as their own text —
    // NOT the editor-state wrapper, which quotes document content.
    crossBoundary = await buildSessionGuard({
      docId: args.docId,
      initiatorUserId: args.userId,
      workspaceId: args.workspaceId,
      ydoc: aiSession.ydoc,
      channel: args.channel,
      invokerText: [args.prompt],
      knowledgeFiles: args.knowledgeFiles
    })

    await runAgenticLoop({
      // Phase 5: `ai` arg is for the unit-test seam only; production
      // routes through LiteLLM via the user's virtual key. `model` and
      // `thinkingBudget` are also test-seam-only — the model comes from
      // the session's resolved chat provider (`aiSession.aiProviders.chat`).
      model: '',
      systemPrompt: args.systemPrompt,
      initialPrompt: args.wrappedPrompt,
      promptPreamble: args.promptPreamble,
      toolDeclarations: args.toolDeclarations,
      thinkingBudget: 0,
      aiSession,
      sessionId: args.sessionId,
      abortController: args.abortController,
      setStatus,
      billingContext: args.billingContext,
      crossBoundary,
      onToolCall: (name, validatedArgs) => recordToolCallMemory(args, name, validatedArgs)
    })
  } catch (e: unknown) {
    handlePromptLoopError(e, args, setStatus)
  } finally {
    clearTimeout(args.deadlineTimer)
    // Leave the final status visible long enough for clients to latch it —
    // errors need more time than success so the user can read the message.
    const lingerMs = status.phase === 'error' ? 2500 : 500
    await new Promise(r => setTimeout(r, lingerMs))
    if (aiSession) await aiSession.destroy()
    // The AI has left the document: its edits count as the invoker's
    // own only if the session never read anybody else's content.
    await finalizeSessionProvenance(args.sessionId, crossBoundary)
    await removeAiSession(args.sessionId)
  }
}

/**
 * Record the user's verbatim prompt FIRST — before the AI Hocuspocus
 * client opens. Memory captures the user's INTENT, and their intent
 * is "I asked X" regardless of whether the downstream sync / model
 * spin-up succeeds. Storing the BARE prompt (not the editor-state-
 * wrapped one) — the model doesn't need to re-see its own
 * scaffolding, just the human-typed words. Failures are swallowed;
 * memory is never load-bearing on the request itself.
 */
async function recordUserPromptMemory(args: PromptLoopArgs): Promise<void> {
  try {
    await appendAiMessage({
      docId: args.docId,
      userId: args.userId,
      sessionId: args.sessionId,
      kind: 'user_prompt',
      body: { text: args.prompt }
    })
  } catch (e) {
    console.warn(`[ai/prompt] user_prompt memory append failed: ${e instanceof Error ? e.message : e}`)
  }
}

/**
 * Per-call memory recorder. Compacted to {name, summary} only — the
 * result payload is intentionally NOT recorded so the model re-issues
 * the call if it needs the data again. Skip noise tools
 * (view_document, read_comments, etc.) that the model re-runs every
 * turn just to read the current state.
 */
async function recordToolCallMemory(args: PromptLoopArgs, name: string, validatedArgs: unknown): Promise<void> {
  if (!shouldRecordToolInMemory(name)) return
  try {
    await appendAiMessage({
      docId: args.docId,
      userId: args.userId,
      sessionId: args.sessionId,
      kind: 'tool_call',
      body: { name, summary: summarizeToolCall(name, validatedArgs) }
    })
  } catch (e) {
    console.warn(`[ai/prompt] tool_call memory append failed (${name}): ${e instanceof Error ? e.message : e}`)
  }
}

function handlePromptLoopError(
  e: unknown,
  args: PromptLoopArgs,
  setStatus: (phase: StreamStatusPhase, message?: string) => void
): void {
  // Treat anything that happens after we signaled abort as an abort,
  // regardless of the error's name/message. The SDK throws various abort
  // variants (AbortError, ApiError wrapping fetch abort, etc.) — our
  // AbortController is the source of truth.
  const err = e as { name?: string, message?: string }
  const isAbort
    = args.abortController.signal.aborted
      || err?.name === 'AbortError'
      || err?.message === 'aborted'
      || /abort/i.test(String(err?.message ?? ''))
  // The message reaches the initiator only (session channel); other
  // participants just see the phase. BYOK errors are key-redacted where
  // they are raised; upstream text never reaches the user at all
  // (`loopErrorMessage`), the raw error is logged below.
  setStatus(isAbort ? 'done' : 'error', isAbort ? 'Stopped' : `Error: ${loopErrorMessage(e)}`)
  if (isAbort) {
    console.log(`[ai/prompt ${args.sessionId}] aborted by user`)
  } else {
    console.error(`[ai/prompt ${args.sessionId}] loop failed:`, e)
    Sentry.captureException(e, {
      tags: { component: 'aiPrompt', event: 'loop_failed', sessionId: args.sessionId, docId: args.docId }
    })
  }
}
