import * as Sentry from '@sentry/nuxt'
import type * as Y from 'yjs'
import type { Logger } from '~~/shared/logging/core'
import { removeAiSession } from '../../ai/aiSessions'
import { createAiSession } from '../../ai/aiClient'
import { runAgenticLoop } from '../runLoop'
import type { ALL_TOOL_DECLARATIONS } from '../../ai/tools/registry'
import type { StreamStatusPhase } from '../streamStatus'
import { buildSessionGuard } from '../sessionGuard'
import type { CrossBoundaryGuard } from '../crossBoundary'
import { finalizeSessionProvenance } from '../sessionProvenance'
import { loopErrorStatus } from '../loopErrorMessage'
import { aiStatus, toStatusLine, type AiStatusInput } from '~~/shared/ai/statusSteps'
import type { SessionWorkspace, OpenedSession } from './sessionSetup'
import type { DocAccess, UserScope } from '../../../repos/proofs'
import { preselectedSkillsBlock } from '../skills'
import { parseSectionsCached } from '../../ai/tools/sections/parse'

// The background part of an AI session (editor prompt or `@ai` comment
// trigger): open the AI's Y.js client, build the taint gate, run the loop,
// report a failure to the initiator, then always leave the document and
// release the session. The HTTP response has returned by then; all edits
// reach the client over Y.js (server/utils/agentic/AGENTS.md).

export interface AgentSessionSpec {
  docId: string
  userId: number
  /** Write access to the document, proven for the initiator by the route. */
  docAccess: DocAccess<'write'>
  self: UserScope
  workspace: SessionWorkspace
  session: OpenedSession
  systemPrompt: string
  /** Per-document / per-workspace blocks that open the first user message. */
  promptContext?: string
  /** The first user message (the prompt / seed, wrapped with the editor state). */
  initialPrompt: string
  /** Per-prompt context (conversation memory) that opens the first user message. */
  promptPreamble?: string
  /** What the initiator typed for this session, their own text for the taint gate. */
  invokerText: string
  /** The request the skill preselection reads (`agentic/skills/`); none = no preselected skills. */
  skillRequest?: string
  toolDeclarations: typeof ALL_TOOL_DECLARATIONS
  workspaceId: string | null
  knowledgeFiles: SessionWorkspace['knowledgeFiles']
  /** The `@ai` thread: awareness highlight, salvage target, terminator. */
  commentThreadId?: string
  /** Why the session starts tainted even on a solo document (a thread with other participants). */
  extraInitialTaint?: string | null
  onToolCall?: (name: string, validatedArgs: unknown) => Promise<void>
  /** Suggestion mode: the AI's text edits become suggestions. */
  suggest?: { forced: boolean } | null
  /** Runs first, before the AI joins the document (conversation memory of the prompt). */
  beforeStart?: () => Promise<void>
  log: Logger
  /** Fields of the failure log line and Sentry tags (besides the error). */
  failure: { component: string, fields: Record<string, string> }
}

/**
 * Background fire-and-forget runner. `status.phase` is wrapped (rather than a
 * `let lastPhase`) because TS control-flow analysis would narrow a literal
 * through try/catch and reject the `finally` comparison with `'error'`.
 */
export async function runAgentSession(spec: AgentSessionSpec): Promise<void> {
  const { session } = spec
  let aiSession: Awaited<ReturnType<typeof createAiSession>> | null = null
  let crossBoundary: CrossBoundaryGuard | null = null
  const status: { phase: StreamStatusPhase } = { phase: 'thinking' }
  const setStatus = (phase: StreamStatusPhase, input?: AiStatusInput) => {
    status.phase = phase
    if (aiSession) {
      aiSession.updateStatus(phase, input)
      return
    }
    const line = toStatusLine(input)
    void session.channel.setStatus({ phase, message: line?.text ?? null, step: line?.step ?? null })
  }

  await spec.beforeStart?.()
  try {
    aiSession = await createAiSession(spec.docId, {
      sessionId: session.sessionId,
      initiatorName: session.initiatorName,
      initiatorUserId: spec.userId,
      initiatorColor: session.initiatorColor,
      channel: session.channel,
      workspaceId: spec.workspaceId,
      docAccess: spec.docAccess,
      self: spec.self,
      workspaceAccess: spec.workspace.workspaceAccess,
      attributedTo: session.billingContext.attributedTo,
      plan: session.billingContext.plan,
      periodStart: session.billingContext.periodStart,
      virtualKey: session.billingContext.virtualKey,
      aiProviders: session.aiProviders,
      commentThreadId: spec.commentThreadId,
      deadlineAt: session.deadlineAt,
      suggest: spec.suggest ?? null
    }, session.abortController.signal)

    // Taint gate: other people's text (document edits, comments, web pages,
    // knowledge files, other documents) makes cross-document / knowledge / web
    // tools ask the initiator first. Only what the initiator typed counts as
    // their own, NOT the editor-state wrapper, which quotes document content.
    crossBoundary = await buildSessionGuard({
      docId: spec.docId,
      initiatorUserId: spec.userId,
      workspaceAccess: spec.workspace.workspaceAccess,
      ydoc: aiSession.ydoc,
      channel: session.channel,
      invokerText: [spec.invokerText],
      knowledgeFiles: spec.knowledgeFiles,
      contextDocIds: spec.workspace.contextDocIds,
      extraInitialTaint: spec.extraInitialTaint
    })

    await runAgenticLoop({
      // `ai` is a unit-test seam; production routes through LiteLLM via the
      // user's virtual key. `model` and `thinkingBudget` are test-only too: the
      // model comes from the session's resolved chat provider.
      model: '',
      systemPrompt: spec.systemPrompt,
      initialPrompt: spec.initialPrompt,
      promptContext: spec.promptContext,
      promptSkills: skillsFor(spec.skillRequest, aiSession.ydoc),
      promptPreamble: spec.promptPreamble,
      toolDeclarations: spec.toolDeclarations,
      thinkingBudget: 0,
      aiSession,
      sessionId: session.sessionId,
      abortController: session.abortController,
      deadlineAt: session.deadlineAt,
      setStatus,
      billingContext: session.billingContext,
      // Makes runLoop's salvage path call `reply_to_comment` instead of
      // `message_to_user` when the model emits prose with no tool call;
      // otherwise the comment thread looks ignored.
      commentThreadId: spec.commentThreadId,
      crossBoundary,
      onToolCall: spec.onToolCall
    })
  } catch (e: unknown) {
    reportLoopFailure(e, spec, setStatus)
  } finally {
    clearTimeout(session.deadlineTimer)
    // Leave the final status visible long enough for clients to latch it,
    // errors need more time than success so the user can read the message.
    const lingerMs = status.phase === 'error' ? 2500 : 500
    await new Promise(r => setTimeout(r, lingerMs))
    if (aiSession) await aiSession.destroy()
    // The AI has left the document: its edits count as the invoker's
    // own only if the session never read anybody else's content.
    await finalizeSessionProvenance(spec.docAccess, session.sessionId, crossBoundary)
    await removeAiSession(spec.self, session.sessionId)
  }
}

/**
 * The skill bodies preselected for this request and document size; they
 * open the first user message after the per-document context, so the
 * system message and tools stay the shared cached prefix.
 */
function skillsFor(request: string | undefined, ydoc: Y.Doc): string {
  if (request === undefined) return ''
  const documentTokens = parseSectionsCached(ydoc.getText('content').toJSON()).totals.tokens
  return preselectedSkillsBlock({ request, documentTokens })
}

function reportLoopFailure(
  e: unknown,
  spec: AgentSessionSpec,
  setStatus: (phase: StreamStatusPhase, status?: AiStatusInput) => void
): void {
  // Anything after the abort signal counts as an abort: the SDK throws various
  // abort variants and our AbortController is the source of truth.
  const err = e as { name?: string, message?: string }
  const isAbort
    = spec.session.abortController.signal.aborted
      || err?.name === 'AbortError'
      || err?.message === 'aborted'
      || /abort/i.test(String(err?.message ?? ''))
  // The message reaches the initiator only (session channel); other
  // participants just see the phase. BYOK errors are key-redacted where
  // they are raised; upstream text never reaches the user at all
  // (`loopErrorMessage`), the raw error is logged below.
  if (isAbort) {
    setStatus('done', aiStatus('stopped'))
  } else {
    const error = loopErrorStatus(e)
    setStatus('error', { text: `Error: ${error.text}`, step: error.step })
  }
  if (isAbort) {
    spec.log.info('aborted by user', { sessionId: spec.session.sessionId })
  } else {
    spec.log.error('loop failed', { ...spec.failure.fields, err: e })
    Sentry.captureException(e, {
      tags: { component: spec.failure.component, event: 'loop_failed', ...spec.failure.fields }
    })
  }
}
