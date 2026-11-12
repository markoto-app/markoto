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
import { AI_SESSION_HARD_DEADLINE_MS } from '../../utils/agentic/limits'
import { buildSessionGuard } from '../../utils/agentic/sessionGuard'
import type { CrossBoundaryGuard } from '../../utils/agentic/crossBoundary'
import { finalizeSessionProvenance, recordSessionProvenance } from '../../utils/agentic/sessionProvenance'
import { loopErrorMessage } from '../../utils/agentic/loopErrorMessage'
import { aiPromptBody } from '~~/shared/api/ai'
import { useLogger } from '../../utils/platform/logger'

const log = useLogger('ai-prompt')

export default defineApiHandler({
  access: allow.doc('write-content', { docId: { from: 'body' } }),
  body: aiPromptBody,
  handler: async ({ event, user, docId, body }) => {
    const userId = user.id
    const userName = user.name

    // The text loop always runs through LiteLLM (the secret validator enforces
    // its URL and master key at boot); its per-user-key rpm_limit is the only
    // rate limit.
    const { prompt, wrappedPrompt } = promptInputs(body)

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
    // Ordered for prompt caching (`agentic/promptAssembly.ts`): the system
    // message is static-first, and the per-prompt conversation memory opens the
    // first USER message (`promptPreamble`) instead. Placing it in the system
    // message invalidated the cached tool definitions on Mistral Small.
    const systemPrompt = assemblePromptSystemPrompt(PROMPT_SYSTEM_PROMPT, {
      documentContextBlock,
      knowledgeBlock: buildKnowledgeBlock(wsCtx.knowledgeFiles),
      membersBlock: buildWorkspaceMembersBlock(wsCtx.members)
    })

    // Resolve billing context up-front to lazily create the LiteLLM virtual key
    // and pick the attribution. No exhaustion pre-check: the proxy enforces
    // `max_budget` on the first model call and runLoop catches
    // `LitellmBudgetExhausted` / `isBudgetExceededError(...)`.
    const billingContext = await resolveBillingContext(userId, wsCtx.workspaceId)
    // BYOK: the user's own provider (or the instance default). No chat
    // provider → 409 `ai/provider-missing` with a link to the settings page.
    const aiProviders = await requireAiProviders(userId, 'chat', billingContext.plan)
    // Hosted free tier: the shared monthly pool may be used up — answer
    // 402 `ai/free-allowance-exhausted` before opening a session (own-key
    // users are never refused here).
    await assertFreeAllowanceAvailable(aiProviders.chat, billingContext.plan)

    const initiatorName = (await findUserNameById(userId)) || userName
    const initiatorColor = '#d97706'

    const sessionId = nanoid(12)
    const abortController = new AbortController()
    const req = event.node?.req
    req?.once?.('close', () => {
      if (!req.readableEnded) abortController.abort()
    })

    await claimAiSession({ sessionId, docId, userId, initiatorName, initiatorColor, abortController })
    const deadlineTimer = setTimeout(() => abortController.abort(), AI_SESSION_HARD_DEADLINE_MS)
    // Initiator-only channel: prompt, status text, answers, confirmations.
    // Opened before the response so the client's first poll finds it.
    const channel = new AiSessionChannel(sessionId)
    await channel.open({ initiatorUserId: userId, docId, prompt, commentThreadId: null })

    // Runs in the background; the HTTP response returns after registration and
    // all edits reach the client over Y.js. See server/utils/agentic/AGENTS.md.
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
  }
})

/** The prompt plus the optional editor-state snapshot; a bad snapshot falls back to `kind: 'none'` instead of failing the request. */
function promptInputs(body: { prompt: string, editorSelection?: unknown }): { prompt: string, wrappedPrompt: string } {
  const editorSelection = validateEditorSelection(body.editorSelection)
  return { prompt: body.prompt, wrappedPrompt: wrapPromptWithEditorState(body.prompt, editorSelection) }
}

interface PromptWorkspaceCtx {
  workspaceId: string | null
  knowledgeFiles: Awaited<ReturnType<typeof listReadyKnowledgeBrief>>
  members: Array<{ userId: number, name: string }>
  toolDeclarations: typeof ALL_TOOL_DECLARATIONS
}

/** Knowledge tools need a workspace doc, a member caller and at least one ready knowledge file. */
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
 * Conversation memory for THIS (doc, user) pair; empty when there are no prior
 * rows or the latest is older than the idle gap (60 min). Read failures
 * degrade to no memory rather than blocking the prompt.
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
    log.warn('conversation memory load failed', { err: e })
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
      throw apiError('ai/duplicate-session')
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
 * Background fire-and-forget runner. `status.phase` is wrapped (rather than a
 * `let lastPhase`) because TS control-flow analysis would narrow a literal
 * through try/catch and reject the `finally` comparison with `'error'`.
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

    // Taint gate: other people's text (document edits, comments, web pages,
    // knowledge files, other documents) makes cross-document / knowledge / web
    // tools ask the initiator first. Only what the initiator typed counts as
    // their own, NOT the editor-state wrapper, which quotes document content.
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
      // `ai` is a unit-test seam; production routes through LiteLLM via the
      // user's virtual key. `model` and `thinkingBudget` are test-only too: the
      // model comes from the session's resolved chat provider.
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
 * Records the user's verbatim prompt FIRST, before the AI Hocuspocus client
 * opens, so memory captures the intent even if sync / model spin-up fails.
 * Stores the bare prompt, not the editor-state-wrapped one. Failures are
 * swallowed; memory is never load-bearing.
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
    log.warn('user_prompt memory append failed', { err: e })
  }
}

/**
 * Per-call memory recorder: {name, summary} only, without the result payload,
 * so the model re-issues a call when it needs the data again. Skips noise
 * tools (view_document, read_comments, ...) the model re-runs every turn.
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
    log.warn('tool_call memory append failed', { tool: name, err: e })
  }
}

function handlePromptLoopError(
  e: unknown,
  args: PromptLoopArgs,
  setStatus: (phase: StreamStatusPhase, message?: string) => void
): void {
  // Anything after the abort signal counts as an abort: the SDK throws various
  // abort variants and our AbortController is the source of truth.
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
    log.info('aborted by user', { sessionId: args.sessionId })
  } else {
    log.error('loop failed', { sessionId: args.sessionId, docId: args.docId, err: e })
    Sentry.captureException(e, {
      tags: { component: 'aiPrompt', event: 'loop_failed', sessionId: args.sessionId, docId: args.docId }
    })
  }
}
