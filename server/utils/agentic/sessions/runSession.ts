import * as Sentry from '@sentry/nuxt'
import type { Logger } from '~~/shared/logging/core'
import { removeAiSession } from '../../ai/aiSessions'
import { createAiSession } from '../../ai/aiClient'
import { runAgenticLoop } from '../runLoop'
import type { ALL_TOOL_DECLARATIONS } from '../../ai/tools/registry'
import type { StreamStatusPhase } from '../streamStatus'
import { buildSessionGuard } from '../sessionGuard'
import type { CrossBoundaryGuard } from '../crossBoundary'
import { finalizeSessionProvenance } from '../sessionProvenance'
import { loopErrorMessage } from '../loopErrorMessage'
import type { SessionWorkspace, OpenedSession } from './sessionSetup'
import type { DocAccess, UserScope } from '../../../repos/proofs'

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
  /** The first user message (the prompt / seed, wrapped with the editor state). */
  initialPrompt: string
  /** Per-prompt context (conversation memory) that opens the first user message. */
  promptPreamble?: string
  /** What the initiator typed for this session, their own text for the taint gate. */
  invokerText: string
  toolDeclarations: typeof ALL_TOOL_DECLARATIONS
  workspaceId: string | null
  knowledgeFiles: SessionWorkspace['knowledgeFiles']
  /** The `@ai` thread: awareness highlight, salvage target, terminator. */
  commentThreadId?: string
  /** Why the session starts tainted even on a solo document (a thread with other participants). */
  extraInitialTaint?: string | null
  onToolCall?: (name: string, validatedArgs: unknown) => Promise<void>
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
  const setStatus = (phase: StreamStatusPhase, message?: string) => {
    status.phase = phase
    if (aiSession) aiSession.updateStatus(phase, message)
    else void session.channel.setStatus({ phase, message: message ?? null })
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
      commentThreadId: spec.commentThreadId
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
      extraInitialTaint: spec.extraInitialTaint
    })

    await runAgenticLoop({
      // `ai` is a unit-test seam; production routes through LiteLLM via the
      // user's virtual key. `model` and `thinkingBudget` are test-only too: the
      // model comes from the session's resolved chat provider.
      model: '',
      systemPrompt: spec.systemPrompt,
      initialPrompt: spec.initialPrompt,
      promptPreamble: spec.promptPreamble,
      toolDeclarations: spec.toolDeclarations,
      thinkingBudget: 0,
      aiSession,
      sessionId: session.sessionId,
      abortController: session.abortController,
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

function reportLoopFailure(
  e: unknown,
  spec: AgentSessionSpec,
  setStatus: (phase: StreamStatusPhase, message?: string) => void
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
  setStatus(isAbort ? 'done' : 'error', isAbort ? 'Stopped' : `Error: ${loopErrorMessage(e)}`)
  if (isAbort) {
    spec.log.info('aborted by user', { sessionId: spec.session.sessionId })
  } else {
    spec.log.error('loop failed', { ...spec.failure.fields, err: e })
    Sentry.captureException(e, {
      tags: { component: spec.failure.component, event: 'loop_failed', ...spec.failure.fields }
    })
  }
}
