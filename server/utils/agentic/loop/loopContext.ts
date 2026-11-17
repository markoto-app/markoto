import type {
  AgenticContent as Content,
  AgenticFunctionCall as FunctionCall,
  AgenticFunctionDeclaration as FunctionDeclaration,
  AgenticAIClient as AiClient
} from '../aiTypes'
import type { AiSession } from '../../ai/aiClient'
import type { AiStatusInput } from '~~/shared/ai/statusSteps'
import type { BillingContext } from '../../billing/billing'
import type { CrossBoundaryGuard } from '../crossBoundary'
import type { EditProgressTracker } from '../editProgress'
import type { ImageUrlProvenance } from '../imageProvenance'
import type { StreamStatusPhase } from '../streamStatus'
import type { SessionBudget } from './sessionBudget'
import type { SessionOutcome, SessionTelemetry } from './sessionTelemetry'

// The state one agentic-loop session threads through its modules (turn
// loop, provider stream, tool dispatch, salvage) and the outcomes they hand
// back to the turn loop.

export interface RunLoopOptions {
  /**
   * Test seam: production callers omit this and the loop streams through
   * LiteLLM. Tests inject a fake `AgenticAIClient` to drive the loop
   * without LiteLLM.
   */
  ai?: AiClient
  model: string
  systemPrompt: string
  initialPrompt: string
  /**
   * Per-document / per-workspace blocks (document context, knowledge files,
   * members) that OPEN the first user message. Kept out of `systemPrompt` so
   * the system message + tool definitions are one cacheable prefix for every
   * user and document (see `promptAssembly.ts`).
   */
  promptContext?: string
  /**
   * Per-prompt context (conversation memory) that follows `promptContext`
   * in the first user message, ahead of `initialPrompt`. Neither is part of
   * the image-provenance "seen" text: that stays what the user typed + the
   * document.
   */
  promptPreamble?: string
  aiSession: AiSession
  sessionId: string
  abortController: AbortController
  setStatus: (phase: StreamStatusPhase, status?: AiStatusInput) => void
  /** Reasoning-token knob; 0 = thinking disabled. Mistral has no equivalent, so only the test seam uses it. */
  thinkingBudget?: number
  /**
   * Override the function declarations handed to the model. Defaults
   * to `ALL_TOOL_DECLARATIONS`. Workspace docs with knowledge files
   * pass `[...ALL_TOOL_DECLARATIONS, ...KNOWLEDGE_TOOL_DECLARATIONS]`.
   */
  toolDeclarations?: FunctionDeclaration[]
  billingContext: BillingContext
  /** Optional logger: defaults to the `ai-loop` logger at debug level, tagged with the session id. */
  logger?: (msg: string) => void
  /**
   * Optional callback fired ONCE per validated tool call (after Zod
   * validation, before per-tool cap checks). Used by the prompt
   * endpoint to record an `ai_session_messages` row so the next
   * prompt's `<conversation_history>` block reflects what this session
   * did. Fire-and-forget: errors swallowed inside the loop.
   *
   * `message_to_user` is recorded SEPARATELY by its handler (it has
   * the verbatim body the prompt block needs) so we skip it here to
   * avoid a duplicate.
   */
  onToolCall?: (name: string, validatedArgs: unknown) => Promise<void>
  /**
   * When this session was triggered by an `@markoto` mention in a
   * comment thread, the thread id rides on opts so the salvage path
   * (model emits prose instead of a tool call) calls
   * `reply_to_comment` against this thread instead of the default
   * `message_to_user`.
   */
  commentThreadId?: string | null
  /**
   * Taint + confirm gate (see `crossBoundary.ts`). Required so no caller
   * can start a loop that reaches the initiator's other documents,
   * knowledge or the web without it. Built per session by
   * `buildSessionGuard` in the prompt / comment-trigger endpoints.
   */
  crossBoundary: CrossBoundaryGuard
}

/**
 * Per-session bag of state passed to the loop's modules. Internal to the
 * loop: callers configure a session through `RunLoopOptions`.
 */
export interface LoopContext {
  opts: RunLoopOptions
  log: (msg: string) => void
  budget: SessionBudget
  telemetry: SessionTelemetry
  contents: Content[]
  toolDeclarations: FunctionDeclaration[]
  thinkingBudget: number
  /** Classifies document edits; ends sessions that only shuffle whitespace / undo themselves. */
  progress: EditProgressTracker
  /** Text this session has seen; an edit may only add images whose URL occurs in it (`imageProvenance.ts`). */
  imageProvenance: ImageUrlProvenance
  /** A document edit (replace_text / insert_text) succeeded in this session. */
  editedDocument: boolean
  /** A `message_to_user` answer was delivered in this session. */
  answeredUser: boolean
}

export type ResponseParts = NonNullable<Content['parts']>

/**
 * Outcome of dispatching one tool call. The loop folds these into the
 * turn's `responseParts` and reacts to terminators.
 */
export type DispatchOutcome
  = | { kind: 'continue', responseParts: ResponseParts }
    | { kind: 'session-cap-exceeded', message: string }
    | { kind: 'provider-unavailable', message: string }
    | { kind: 'comment-trigger-done', responseParts: ResponseParts }

/**
 * Result of running one full turn (LLM call + tool dispatch). The main
 * loop branches on this to either continue, return cleanly, or
 * propagate state.
 */
export type TurnResult
  = | { kind: 'continue' }
    | { kind: 'done', outcome: SessionOutcome }
    | { kind: 'budget-exhausted' }

/** Build a tool-error functionResponse part for the given call. */
export function toolErrorResponse(call: FunctionCall, output: string): ResponseParts[number] {
  return {
    functionResponse: {
      id: call.id,
      name: call.name,
      response: { output, isError: true }
    }
  }
}

export function throwIfAborted(ctx: LoopContext): void {
  if (!ctx.opts.abortController.signal.aborted) return
  ctx.telemetry.outcome = 'aborted'
  ctx.telemetry.abortReason = 'signal'
  throw new Error('aborted')
}

/** Current document text, or null when the session has no readable Y.Text (the unit-test seam passes a bare session stub). */
export function readDocText(session: AiSession): string | null {
  try {
    return session.ytext.toJSON()
  } catch {
    return null
  }
}

/** The session answers an `@markoto` mention in a comment thread (its reply is the deliverable). */
export function isCommentTriggerSession(ctx: LoopContext): boolean {
  return typeof ctx.opts.commentThreadId === 'string' && ctx.opts.commentThreadId.length > 0
}
