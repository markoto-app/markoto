import {
  AgenticFinishReason as FinishReason,
  type AgenticContent as Content,
  type AgenticFunctionCall as FunctionCall,
  type AgenticFunctionDeclaration as FunctionDeclaration,
  type AgenticAIClient as AiClient
} from './aiTypes'
import * as Sentry from '@sentry/nuxt'
import { litellmStream } from '../litellm/createCompletion'
import type { AiSession } from '../aiClient'
import type { BillingContext } from '../billing'
import { getWebToolAvailability } from '../webTools'
import { LitellmBudgetExhausted, isBudgetExceededError } from '../litellmKeys'
import { executeFunctionByName } from '../aiToolAdapter'
import { ALL_TOOL_DECLARATIONS, TOOL_SCHEMAS, filterToolsForProviders, webSearch, fetchUrl } from './functionTools'
import { SESSION_INTERACTION_CAP, SESSION_TOOL_CALL_CAPS } from './limits'
import {
  internalToOpenAIMessages,
  internalToOpenAITools,
  openAIStreamToInternalChunks,
  type StreamChunk
} from './messageTranslation'
import { useLitellmForUser } from '../litellmClient'
import { providerRequestFields, withProviderErrors, redactProviderStream } from '../aiProviders/requestFields'
import type { CrossBoundaryGuard } from './crossBoundary'
import type { ResolvedAiProvider } from '../aiProviders/resolve'
import { FEATURE_TAGS, featureMetadata } from '../litellm/featureTags'
import { appendActivity, pruneActivity, type ActivityMetadata } from '../../repos/activity'
import { aiClientUserId } from '~~/shared/contracts/jwt'
import { docExists } from '../../repos/documents'
import { budgetExhaustedBreadcrumb } from '../billingMode'
import {
  DOC_EDIT_TOOLS,
  EditProgressTracker,
  NO_OP_EDIT_ERROR_PREFIX,
  STALLED_TURN_LIMIT,
  stalledEditNote
} from './editProgress'
import {
  newStreamState,
  processChunk,
  type StreamStatusPhase
} from './streamStatus'

/**
 * Outcome categories surfaced to Sentry on session end. Indexed as a
 * tag (`outcome`) so dashboards can filter / count without parsing
 * extras.
 */
type SessionOutcome
  = | 'success'
    | 'aborted'
    | 'error'
    | 'session-cap-exceeded'
    | 'budget-exhausted'
    | 'turn-limit'
    | 'stalled'

/**
 * The agentic loop: stream from the LLM (Mistral via LiteLLM) with
 * function calling, dispatch each tool call, loop until the model replies
 * without a tool call (its finish signal; prose is salvaged into one
 * closing tool call unless the session already edited the document or
 * answered the user) or we hit a stop condition — including
 * `STALLED_TURN_LIMIT` turns in a row whose edits changed nothing but
 * whitespace / reverted earlier edits (see `editProgress.ts`).
 *
 * Returns normally on STOP; throws on abort. Status transitions are
 * reported via setStatus(...) at every state change.
 */

const MAX_TURNS = 20

/**
 * Terminal non-STOP finishReasons that indicate the model gave up but
 * didn't end cleanly. We bail even if functionCalls were emitted —
 * MALFORMED_FUNCTION_CALL means the args are junk and re-trying would
 * just produce more junk.
 */
const TERMINAL_BAIL_REASONS: ReadonlySet<FinishReason | undefined> = new Set([
  FinishReason.MALFORMED_FUNCTION_CALL,
  FinishReason.UNEXPECTED_TOOL_CALL,
  FinishReason.SAFETY,
  FinishReason.PROHIBITED_CONTENT
])

/** Schema cap on the synthesised salvage `message_to_user.message` field. */
const SALVAGE_MESSAGE_MAX = 600

/**
 * Per-session SAFETY cap counter. Two-axis:
 *   - `interactions`: total interactions across all turns + sub-calls.
 *     Crossing SESSION_INTERACTION_CAP means runaway loop / prompt-
 *     injection ping-pong; we abort the session via setStatus('error').
 *   - `toolCallCounts`: per-tool ceiling. Crossing returns a TOOL ERROR
 *     so the model can wrap up gracefully (vs aborting the session).
 *
 * Independent of the per-user monthly $ budget — that's LiteLLM's job.
 */
class SessionBudget {
  private interactions = 0
  private readonly toolCallCounts = new Map<string, number>()

  /**
   * Try to charge `delta` interactions. Returns `{ ok: false, message }`
   * if the cap would be crossed (caller should exit cleanly via the
   * existing setStatus('error') path); `{ ok: true }` otherwise.
   */
  consumeInteractions(delta: number, reason: string, log: (m: string) => void): { ok: true } | { ok: false, message: string } {
    if (this.interactions + delta > SESSION_INTERACTION_CAP) {
      const message = `Session interaction cap reached (${SESSION_INTERACTION_CAP}). The agentic loop ran too long; please try a more focused prompt.`
      log(`[limits] session interaction cap reached (${this.interactions}+${delta} > ${SESSION_INTERACTION_CAP}); aborting`)
      return { ok: false, message }
    }
    this.interactions += delta
    log(`[runLoop] noted +${delta} (${reason}; session=${this.interactions})`)
    return { ok: true }
  }

  /**
   * Try to claim a tool slot for `name`. Returns false if the tool's
   * cap was already exhausted; true (and increments the slot counter)
   * otherwise. Tools without a configured cap are unlimited.
   */
  claimToolSlot(name: string): boolean {
    const cap = SESSION_TOOL_CALL_CAPS[name]
    if (typeof cap !== 'number') return true
    const used = this.toolCallCounts.get(name) ?? 0
    if (used >= cap) return false
    this.toolCallCounts.set(name, used + 1)
    return true
  }

  toolCap(name: string): number | undefined {
    return SESSION_TOOL_CALL_CAPS[name]
  }

  totalInteractions(): number {
    return this.interactions
  }
}

/**
 * Single-emit accumulator for the `ai-session-completed` Sentry event.
 * Every exit path (success / abort / error / cap) funnels through
 * `emit()` from the loop's finally block so dashboards can answer
 * "which sessions cost the most" without correlating LiteLLM spend
 * logs by hand.
 */
class SessionTelemetry {
  readonly startedAt = Date.now()
  turnCount = 0
  totalInputTokens = 0
  totalOutputTokens = 0
  totalThinkingTokens = 0
  sawAnyUsageMetadata = false
  outcome: SessionOutcome = 'error'
  abortReason?: string
  errorMessage?: string
  /**
   * Per-tool ATTEMPT counts (records EVERY invocation, including
   * cap-rejected and errored ones). Distinct from SessionBudget's
   * tool-cap counter which only ticks on accepted slots.
   */
  readonly toolCallCounts = new Map<string, number>()

  noteUsage(usage: { promptTokenCount?: number, candidatesTokenCount?: number, thoughtsTokenCount?: number } | undefined): void {
    if (!usage) return
    this.sawAnyUsageMetadata = true
    if (typeof usage.promptTokenCount === 'number') this.totalInputTokens += usage.promptTokenCount
    if (typeof usage.candidatesTokenCount === 'number') this.totalOutputTokens += usage.candidatesTokenCount
    if (typeof usage.thoughtsTokenCount === 'number') this.totalThinkingTokens += usage.thoughtsTokenCount
  }

  noteToolAttempt(name: string): void {
    this.toolCallCounts.set(name, (this.toolCallCounts.get(name) ?? 0) + 1)
  }

  emit(args: {
    sessionId: string
    aiSession: AiSession
    plan: string
    attributedTo: string
    totalInteractions: number
  }): void {
    try {
      const toolCounts: Record<string, number> = {}
      for (const [k, v] of this.toolCallCounts) toolCounts[k] = v

      Sentry.captureMessage('ai-session-completed', {
        level: 'info',
        tags: {
          component: 'ai-session',
          event: 'completed',
          outcome: this.outcome,
          docId: args.aiSession.docId,
          // String for tag-search compatibility — Sentry's tag filter
          // works on string equality, not numeric comparison.
          initiatorUserId: String(args.aiSession.initiatorUserId)
        },
        extra: {
          sessionId: args.sessionId,
          turnCount: this.turnCount,
          totalInteractions: args.totalInteractions,
          // -1 sentinel when the SDK never surfaced usageMetadata —
          // preserves "no data" vs "actually 0" distinction.
          totalInputTokens: this.sawAnyUsageMetadata ? this.totalInputTokens : -1,
          totalOutputTokens: this.sawAnyUsageMetadata ? this.totalOutputTokens : -1,
          totalThinkingTokens: this.sawAnyUsageMetadata ? this.totalThinkingTokens : -1,
          toolCallCounts: toolCounts,
          abortReason: this.abortReason,
          errorMessage: this.errorMessage,
          durationMs: Date.now() - this.startedAt,
          plan: args.plan,
          attributedTo: args.attributedTo
        }
      })
    } catch (e) {
      // Don't go through the user-facing `log` helper — that prefix is
      // for prompt-loop chatter. console.warn keeps it visible while
      // making clear the error is from the telemetry path.
      console.warn(`[runLoop telemetry] capture failed: ${e instanceof Error ? e.message : e}`)
    }
  }
}

/**
 * Emit an `ai.tool` activity row for a meta-tool the AI just used.
 * Limited to tools that don't surface in the Y.Doc state and would
 * otherwise be invisible to collaborators (web_search, fetch_url,
 * generate_image, etc.). Doc-mutating tools bubble through sync-server
 * and emit their own activity events.
 *
 * Fire-and-forget — failures must never block the agentic loop.
 */
async function logAiTool(
  docId: string,
  sessionId: string,
  metadata: Extract<ActivityMetadata, { kind: 'ai.tool' }>
): Promise<void> {
  try {
    if (!(await docExists(docId))) return
    await appendActivity({
      docId,
      userName: 'AI Assistant',
      // Carries the synthetic principal so the activity-feed
      // enrichment join can resolve back to the human initiator
      // through `ai_sessions.session_id = sessionId`. Without this,
      // the row would be indistinguishable from a deleted-user edit
      // — `user_id=NULL`, `user_name='AI Assistant'`, no traceback.
      actorPrincipal: aiClientUserId(sessionId),
      action: 'ai.tool',
      metadata
    })
    await pruneActivity(docId)
  } catch (e) {
    console.warn('[runLoop] ai.tool activity log failed:', e instanceof Error ? e.message : e)
  }
}

export interface RunLoopOptions {
  /**
   * Production callers OMIT this. The runLoop routes 100% through
   * LiteLLM → Mistral; the only remaining use of `ai` is the
   * unit-test seam, where tests inject a fake `AgenticAIClient` to
   * drive the loop without LiteLLM. When omitted, the seam path is
   * unreachable.
   */
  ai?: AiClient
  model: string
  systemPrompt: string
  initialPrompt: string
  aiSession: AiSession
  sessionId: string
  abortController: AbortController
  setStatus: (phase: StreamStatusPhase, message?: string) => void
  /**
   * Pre-Phase-5 (Gemini-era) reasoning-token knob. 0 = thinking
   * disabled. Mistral has no equivalent; kept on the surface for the
   * test seam.
   */
  thinkingBudget?: number
  /**
   * Override the function declarations handed to the model. Defaults
   * to `ALL_TOOL_DECLARATIONS`. Workspace docs with knowledge files
   * pass `[...ALL_TOOL_DECLARATIONS, ...KNOWLEDGE_TOOL_DECLARATIONS]`.
   */
  toolDeclarations?: FunctionDeclaration[]
  billingContext: BillingContext
  /** Optional logger — defaults to `console.log` tagged with the session id. */
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
 * Per-session bag of state passed to the helpers extracted from the
 * loop body. Not exported — purely an internal seam to keep
 * `runAgenticLoop` thin.
 */
interface LoopContext {
  opts: RunLoopOptions
  log: (msg: string) => void
  budget: SessionBudget
  telemetry: SessionTelemetry
  contents: Content[]
  toolDeclarations: FunctionDeclaration[]
  thinkingBudget: number
  /** Classifies document edits; ends sessions that only shuffle whitespace / undo themselves. */
  progress: EditProgressTracker
  /** A document edit (replace_text / insert_text) succeeded in this session. */
  editedDocument: boolean
  /** A `message_to_user` answer was delivered in this session. */
  answeredUser: boolean
}

/**
 * Current document text, or null when the session has no readable
 * Y.Text (the unit-test seam passes a bare session stub).
 */
function readDocText(session: AiSession): string | null {
  try {
    return session.ytext.toJSON()
  } catch {
    return null
  }
}

function emitBudgetBreadcrumb(ctx: LoopContext, plan: string): void {
  // Wording depends on the billing mode — never link a purchase that
  // doesn't exist on this deployment.
  const msg = budgetExhaustedBreadcrumb(plan)
  try {
    ctx.opts.aiSession.ydoc.transact(() => {
      ctx.opts.aiSession.ytext.insert(ctx.opts.aiSession.ytext.length, msg)
    }, `ai:assistant:${ctx.opts.sessionId}`)
  } catch (e) {
    ctx.log(`failed to write budget-exhausted breadcrumb: ${e instanceof Error ? e.message : e}`)
  }
  ctx.opts.setStatus('done', 'AI Points exhausted')
}

/**
 * Pull modelParts + functionCalls + finishReason out of one streamed
 * turn. Side effects: calls `processChunk` for status announcements,
 * accumulates token usage on `ctx.telemetry`, and throws on
 * mid-stream abort.
 */
async function consumeStreamTurn(
  stream: AsyncIterable<StreamChunk>,
  ctx: LoopContext
): Promise<{ modelParts: NonNullable<Content['parts']>, functionCalls: FunctionCall[], finishReason: FinishReason | undefined }> {
  const streamState = newStreamState()
  const modelParts: NonNullable<Content['parts']> = []
  const functionCalls: FunctionCall[] = []
  let finishReason: FinishReason | undefined

  for await (const chunk of stream) {
    if (ctx.opts.abortController.signal.aborted) {
      ctx.telemetry.outcome = 'aborted'
      ctx.telemetry.abortReason = 'signal'
      throw new Error('aborted')
    }

    processChunk(chunk, streamState, { setStatus: ctx.opts.setStatus, logger: ctx.log })

    const parts = chunk.candidates?.[0]?.content?.parts
    if (parts) modelParts.push(...parts)

    const calls = chunk.functionCalls
    if (calls?.length) functionCalls.push(...calls)

    // `finishReason` is typed `AgenticFinishReason | string` so the
    // LiteLLM stream wrapper can pass through unmapped OpenAI values.
    // We only care about the recognised enum values; anything else is
    // treated as `OTHER` so the existing exit-path code recognises it
    // as terminal.
    const reason = chunk.candidates?.[0]?.finishReason
    if (reason) {
      finishReason = (Object.values(FinishReason) as string[]).includes(reason)
        ? reason as FinishReason
        : FinishReason.OTHER
    }

    ctx.telemetry.noteUsage(chunk.usageMetadata)
  }

  return { modelParts, functionCalls, finishReason }
}

/**
 * Salvage path for turns where the model emitted prose with no tool
 * call. The system prompt forbids this, but Mistral drifts. Without a
 * salvage path the user sees nothing.
 *
 * Fork by session shape: comment-trigger sessions synthesise a
 * `reply_to_comment` against the originating thread; everyone else
 * synthesises `message_to_user(is_question=false)`.
 */
async function salvageProseTurn(
  ctx: LoopContext,
  modelParts: NonNullable<Content['parts']>,
  finishReason: FinishReason | undefined,
  turnCount: number
): Promise<void> {
  const proseText = collectProseText(modelParts)
  if (proseText.length > 0) {
    if (closingTextIsRedundant(ctx)) {
      // The model's finish signal after it already did the work: "Done",
      // "Added the intro." The edit is the receipt, and an earlier
      // `message_to_user` answer must not be replaced by this note.
      ctx.log(`turn ${turnCount}: finished; closing text not shown (${proseText.length} chars)`)
    } else {
      await dispatchSalvageFallback(ctx, proseText, turnCount)
    }
  }
  finalizeSalvageStatus(ctx, finishReason)
}

/**
 * Closing prose is only salvaged when it is the session's sole answer.
 * Comment-trigger sessions always salvage — the thread reply is the
 * deliverable, and a successful reply already ended the loop.
 */
function closingTextIsRedundant(ctx: LoopContext): boolean {
  const isCommentTrigger = typeof ctx.opts.commentThreadId === 'string' && ctx.opts.commentThreadId.length > 0
  if (isCommentTrigger) return false
  return ctx.editedDocument || ctx.answeredUser
}

function collectProseText(modelParts: NonNullable<Content['parts']>): string {
  return modelParts
    .map((p) => {
      const text = (p as { text?: unknown }).text
      return typeof text === 'string' ? text : ''
    })
    .join('')
    .trim()
}

/**
 * Pick the salvage tool by session shape: comment-trigger sessions
 * synthesise a `reply_to_comment` against the originating thread;
 * everyone else synthesises `message_to_user(is_question=false)`.
 */
async function dispatchSalvageFallback(ctx: LoopContext, proseText: string, turnCount: number): Promise<void> {
  const message = proseText.length > SALVAGE_MESSAGE_MAX
    ? proseText.slice(0, SALVAGE_MESSAGE_MAX - 1) + '…'
    : proseText
  const isCommentTrigger = typeof ctx.opts.commentThreadId === 'string' && ctx.opts.commentThreadId.length > 0
  const fallbackTool = isCommentTrigger ? 'reply_to_comment' : 'message_to_user'
  const fallbackArgs: Record<string, unknown> = isCommentTrigger
    ? { comment_id: ctx.opts.commentThreadId, body: message }
    : { message, is_question: false }
  ctx.log(`turn ${turnCount}: salvaging pure-prose response (${proseText.length} chars) via ${fallbackTool} fallback`)
  try {
    await executeFunctionByName(ctx.opts.aiSession, fallbackTool, fallbackArgs)
  } catch (e) {
    ctx.log(`${fallbackTool} fallback failed: ${e instanceof Error ? e.message : e}`)
  }
}

function finalizeSalvageStatus(ctx: LoopContext, finishReason: FinishReason | undefined): void {
  if (finishReason && finishReason !== FinishReason.STOP && finishReason !== FinishReason.MAX_TOKENS) {
    ctx.telemetry.outcome = 'error'
    ctx.telemetry.errorMessage = `finish=${finishReason}`
    ctx.opts.setStatus('error', `Stopped: ${finishReason}`)
  } else {
    ctx.telemetry.outcome = 'success'
    ctx.opts.setStatus('done', 'Done')
  }
}

/**
 * Outcome of dispatching one tool call. The loop folds these into the
 * turn's `responseParts` and reacts to terminators.
 */
type DispatchOutcome
  = | { kind: 'continue', responseParts: NonNullable<Content['parts']> }
    | { kind: 'session-cap-exceeded', message: string }
    | { kind: 'comment-trigger-done', responseParts: NonNullable<Content['parts']> }

/**
 * Validate args for a tool, debit caps, dispatch to the right backend
 * (web_search / fetch_url sub-calls or the regular adapter), build the
 * `functionResponse` part the model expects.
 *
 * NOT responsible for: top-level abort detection (caller checks before
 * entering), turn-level setStatus transitions (caller drives those).
 */
/**
 * Validate args against the registered Zod schema. Returns the
 * validated args on success; on failure returns a `continue` outcome
 * with a tool-error response part so the model sees the schema failure
 * cleanly and can retry. Tools without a registered schema get raw
 * args passed through (executeFunctionByName surfaces "unsupported").
 */
function validateToolArgs(
  ctx: LoopContext,
  call: FunctionCall
): { ok: true, args: unknown } | { ok: false, outcome: DispatchOutcome } {
  const schema = TOOL_SCHEMAS[call.name!]
  if (!schema) return { ok: true, args: call.args ?? {} }
  const parsed = schema.safeParse(call.args ?? {})
  if (parsed.success) return { ok: true, args: parsed.data }
  const zodMsg = parsed.error.issues
    .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ')
  ctx.log(`function_call validation failed: ${call.name}: ${zodMsg}`)
  return {
    ok: false,
    outcome: {
      kind: 'continue',
      responseParts: [toolErrorResponse(call, `Error: invalid arguments for ${call.name}: ${zodMsg}`)]
    }
  }
}

/**
 * Memory event: record the validated call (compacted) before running
 * it. We record BEFORE the cap check so memory reflects what the
 * model attempted, even if the cap rejects this invocation.
 * `message_to_user` is special-cased upstream by its handler so it
 * lands as a verbatim row, not a compacted tool_call row — skip here
 * to avoid a duplicate.
 */
async function recordToolCallMemory(
  ctx: LoopContext,
  name: string,
  validatedArgs: unknown
): Promise<void> {
  if (!ctx.opts.onToolCall || name === 'message_to_user') return
  try {
    await ctx.opts.onToolCall(name, validatedArgs)
  } catch (e) {
    ctx.log(`onToolCall callback failed: ${e instanceof Error ? e.message : e}`)
  }
}

/**
 * Per-tool call-count cap. Independent of the per-user budget —
 * protects a single session from runaway loops on cost-amplifying
 * tools. Returns `null` when the slot is claimed; otherwise a
 * `continue` outcome with a tool-error response so the model wraps
 * up gracefully without further tool use.
 */
function checkToolSlotCap(ctx: LoopContext, call: FunctionCall): DispatchOutcome | null {
  if (ctx.budget.claimToolSlot(call.name!)) return null
  const cap = ctx.budget.toolCap(call.name!) ?? 0
  ctx.log(`[limits] tool call cap reached: ${call.name} (${cap}/${cap})`)
  return {
    kind: 'continue',
    responseParts: [toolErrorResponse(call, `Tool call limit reached for ${call.name} (${cap}). Wrap up your response.`)]
  }
}

interface ToolResult {
  content: string
  isError: boolean
  extraParts?: NonNullable<Content['parts']>
}

/**
 * Run the right backend for the call name. Returns `session-cap-exceeded`
 * when the safety counter trips on a sub-call charge; otherwise returns
 * the tool's result wrapped as `{ kind: 'ok', result }`.
 *
 * web_search / fetch_url charge an extra 4 interactions on the session
 * safety counter; everything else dispatches through the regular tool
 * adapter.
 */
async function runOneTool(
  ctx: LoopContext,
  name: string,
  validatedArgs: unknown
): Promise<{ kind: 'ok', result: ToolResult } | Extract<DispatchOutcome, { kind: 'session-cap-exceeded' }>> {
  if (name === 'web_search' || name === 'fetch_url') {
    const consumed = ctx.budget.consumeInteractions(4, `${name} sub-call`, ctx.log)
    if (!consumed.ok) return { kind: 'session-cap-exceeded', message: consumed.message }
    return { kind: 'ok', result: await runSubCall(ctx, name, validatedArgs) }
  }
  try {
    const result = await executeFunctionByName(ctx.opts.aiSession, name, validatedArgs)
    if (!result.isError) logMetaTool(ctx, name, validatedArgs)
    return { kind: 'ok', result }
  } catch (e: unknown) {
    if (ctx.opts.abortController.signal.aborted) throw e
    const msg = e instanceof Error ? e.message : 'Unknown error'
    ctx.log(`function_call threw: ${name}: ${msg}`)
    return { kind: 'ok', result: { content: `Error: ${name} failed: ${msg}`, isError: true } }
  }
}

/** Build a tool-error functionResponse part for the given call. */
function toolErrorResponse(call: FunctionCall, output: string): NonNullable<Content['parts']>[number] {
  return {
    functionResponse: {
      id: call.id,
      name: call.name,
      response: { output, isError: true }
    }
  }
}

/**
 * Taint gate: once the session has read content the initiator didn't
 * write, cross-document / knowledge / web tools wait for the initiator's
 * explicit approval (prompt-bar confirm). Returns a tool-error outcome
 * when they declined; null when the call may run.
 */
async function gateCrossBoundary(ctx: LoopContext, call: FunctionCall, validatedArgs: unknown): Promise<DispatchOutcome | null> {
  const guard = ctx.opts.crossBoundary
  const name = call.name ?? ''
  if (!guard.needsConfirmation(name, validatedArgs)) return null
  ctx.opts.setStatus('tool', 'Waiting for your confirmation…')
  const gate = await guard.beforeTool(name, validatedArgs, ctx.opts.abortController.signal)
  throwIfAborted(ctx)
  if (gate.allowed) return null
  ctx.log(`[crossBoundary] ${name} declined by the initiator (tainted by: ${guard.taintReasons.join(', ')})`)
  return { kind: 'continue', responseParts: [toolErrorResponse(call, gate.message)] }
}

async function dispatchToolCall(
  ctx: LoopContext,
  call: FunctionCall
): Promise<DispatchOutcome> {
  if (!call.name) return { kind: 'continue', responseParts: [] }

  // Telemetry tally — every attempted invocation, including
  // cap-rejected and errored.
  ctx.telemetry.noteToolAttempt(call.name)
  ctx.log(`function_call: ${call.name} args=${JSON.stringify(call.args).slice(0, 200)}`)

  // Only tools offered to this session may run — e.g. the knowledge
  // tools are not offered without workspace membership + ready files,
  // and a model that names them anyway must not reach the handler.
  if (!ctx.toolDeclarations.some(d => d.name === call.name)) {
    ctx.log(`function_call refused: ${call.name} is not offered in this session`)
    return { kind: 'continue', responseParts: [toolErrorResponse(call, `Error: tool ${call.name} is not available in this session.`)] }
  }

  const validation = validateToolArgs(ctx, call)
  if (!validation.ok) return validation.outcome
  const validatedArgs = validation.args

  await recordToolCallMemory(ctx, call.name, validatedArgs)

  const capExceeded = checkToolSlotCap(ctx, call)
  if (capExceeded) return capExceeded

  const declined = await gateCrossBoundary(ctx, call, validatedArgs)
  if (declined) return declined

  const isDocEdit = DOC_EDIT_TOOLS.has(call.name)
  const textBefore = isDocEdit ? readDocText(ctx.opts.aiSession) : null
  const runResult = await runOneTool(ctx, call.name, validatedArgs)
  if (runResult.kind === 'session-cap-exceeded') return runResult
  const result = runResult.result
  await ctx.opts.crossBoundary.afterTool(call.name, validatedArgs, result)
  if (!result.isError && call.name === 'message_to_user') ctx.answeredUser = true

  let output = result.content
  if (isDocEdit) {
    if (!result.isError) ctx.editedDocument = true
    const verdict = ctx.progress.noteEdit(textBefore, readDocText(ctx.opts.aiSession), {
      isError: result.isError,
      rejectedNoOp: result.isError && result.content.startsWith(NO_OP_EDIT_ERROR_PREFIX),
      call: `${call.name}:${JSON.stringify(validatedArgs)}`
    })
    if (verdict && verdict !== 'progress') ctx.log(`function_call ${call.name}: stalled edit (${verdict})`)
    // A rejected no-op already says so in its error.
    const alreadyExplained = verdict === 'no-change' && result.isError
    const note = verdict && !alreadyExplained ? stalledEditNote(verdict) : null
    if (note) output = `${output}\n\n${note}`
  }

  const responseParts: NonNullable<Content['parts']> = [{
    functionResponse: {
      id: call.id,
      name: call.name,
      response: { output, isError: result.isError }
    }
  }]
  // Tools that return non-JSON payloads (view_image → inlineData) smuggle
  // them out as sibling parts on the same user message. Must come AFTER
  // the functionResponse so the model links them to the right call.
  if (result.extraParts?.length) responseParts.push(...result.extraParts)

  // Comment-trigger terminator: if a successful reply_to_comment
  // landed on the trigger thread, mark for break. Mistral occasionally
  // emits both reply_to_comment AND a hallucinated follow-up tool
  // call — without this the rainbow ring stays lit on the orphaned
  // call until SESSION_INTERACTION_CAP / MAX_TURNS.
  const isCommentTriggerSession = typeof ctx.opts.commentThreadId === 'string' && ctx.opts.commentThreadId.length > 0
  if (isCommentTriggerSession && call.name === 'reply_to_comment' && !result.isError) {
    const a = validatedArgs as { comment_id?: unknown }
    if (typeof a.comment_id === 'string' && a.comment_id === ctx.opts.commentThreadId) {
      return { kind: 'comment-trigger-done', responseParts }
    }
  }

  return { kind: 'continue', responseParts }
}

/**
 * web_search and fetch_url share the same shape: 2-call (Jina then
 * Mistral synthesis). Both run a session-context-aware fetch and emit
 * an ai.tool activity row on success.
 */
async function runSubCall(
  ctx: LoopContext,
  name: 'web_search' | 'fetch_url',
  validatedArgs: unknown
): Promise<{ content: string, isError: boolean }> {
  const subCallContext = {
    workspaceId: ctx.opts.aiSession.workspaceId ?? null,
    userId: ctx.opts.aiSession.initiatorUserId ?? null,
    docId: ctx.opts.aiSession.docId ?? null,
    // The synthesis sub-call authenticates with the caller's virtual key
    // (never the master key) and runs on the session's chat provider —
    // the user's own key under BYOK, so it costs the platform nothing.
    virtualKey: ctx.opts.billingContext.virtualKey,
    chatProvider: ctx.opts.aiSession.aiProviders.chat
  }

  try {
    if (name === 'web_search') {
      const { query } = validatedArgs as { query: string }
      const out = await webSearch(ctx.opts.ai, ctx.opts.model, query, ctx.opts.abortController.signal, subCallContext)
      void logAiTool(ctx.opts.aiSession.docId, ctx.opts.aiSession.sessionId, {
        kind: 'ai.tool',
        tool: 'web_search',
        query: query.slice(0, 200),
        sources: out.sources.slice(0, 10).map(s => ({
          title: s.title.slice(0, 200),
          uri: s.uri.slice(0, 500)
        }))
      })
      return { content: out.text, isError: false }
    }
    const { url } = validatedArgs as { url: string }
    const out = await fetchUrl(ctx.opts.ai, ctx.opts.model, url, ctx.opts.abortController.signal, subCallContext)
    void logAiTool(ctx.opts.aiSession.docId, ctx.opts.aiSession.sessionId, {
      kind: 'ai.tool',
      tool: 'fetch_url',
      url: out.url.slice(0, 500),
      summary: out.summary.slice(0, 600),
      images: out.images.slice(0, 6).map(i => ({
        url: i.url.slice(0, 500),
        description: i.description?.slice(0, 200)
      }))
    })
    return { content: out.text, isError: false }
  } catch (e: unknown) {
    if (ctx.opts.abortController.signal.aborted) throw e
    const msg = e instanceof Error ? e.message : 'Unknown error'
    return { content: `Error: ${name} failed: ${msg}`, isError: true }
  }
}

/**
 * Surface meta-tools (search/fetch already logged inline by runSubCall)
 * to the activity feed so the AI's reads/searches show in the row
 * stream. Skipped: view_document and read_comments (pure noise — AI
 * reads doc state every turn).
 */
type AiToolMeta = Extract<ActivityMetadata, { kind: 'ai.tool' }>

const META_TOOL_BUILDERS: Record<string, (args: unknown) => AiToolMeta> = {
  generate_image: args => ({ kind: 'ai.tool', tool: 'generate_image', prompt: pickStr(args, 'prompt', 300) }),
  view_image: args => ({ kind: 'ai.tool', tool: 'view_image', src: pickStr(args, 'src', 500) }),
  search_knowledge: args => ({ kind: 'ai.tool', tool: 'search_knowledge', query: pickStr(args, 'query', 200) }),
  get_knowledge_file: args => ({ kind: 'ai.tool', tool: 'get_knowledge_file', knowledgeId: pickStr(args, 'knowledge_id', 64) })
}

/** Read a string field from an unknown args bag, trimming to `max`. Returns '' on miss / non-string / non-object. */
function pickStr(args: unknown, key: string, max: number): string {
  if (!args || typeof args !== 'object') return ''
  const v = (args as Record<string, unknown>)[key]
  return typeof v === 'string' ? v.slice(0, max) : ''
}

function logMetaTool(ctx: LoopContext, name: string, validatedArgs: unknown): void {
  const builder = META_TOOL_BUILDERS[name]
  if (!builder) return
  void logAiTool(ctx.opts.aiSession.docId, ctx.opts.aiSession.sessionId, builder(validatedArgs))
}

/**
 * Result of running one full turn (LLM call + tool dispatch). The main
 * loop branches on this to either continue, return cleanly, or
 * propagate state.
 */
type TurnResult
  = | { kind: 'continue' }
    | { kind: 'done', outcome: SessionOutcome }
    | { kind: 'budget-exhausted' }

async function runOneTurn(ctx: LoopContext, turnCount: number): Promise<TurnResult> {
  throwIfAborted(ctx)
  ctx.opts.setStatus('thinking', 'Thinking…')
  ctx.log(`turn ${turnCount}: calling LLM (${ctx.contents.length} messages)`)

  const capResult = chargeTurnBudget(ctx, turnCount)
  if (capResult) return capResult

  const streamResult = await openProviderStream(ctx)
  if (streamResult.kind === 'budget-exhausted') return { kind: 'budget-exhausted' }

  const { modelParts, functionCalls, finishReason } = await consumeStreamTurn(streamResult.stream, ctx)
  ctx.log(`turn ${turnCount}: finishReason=${finishReason}, parts=${modelParts.length}, calls=${functionCalls.length}`)

  // Record the model's response so the next turn (if any) has full
  // history — the continuation contract requires the model's Content
  // block to precede the corresponding functionResponse user block.
  ctx.contents.push({ role: 'model', parts: modelParts })

  // No function calls → salvage prose into a synthesised tool call, exit.
  if (functionCalls.length === 0) {
    await salvageProseTurn(ctx, modelParts, finishReason, turnCount)
    return { kind: 'done', outcome: ctx.telemetry.outcome }
  }

  // Terminal non-STOP finish reasons we should still bail on, even if
  // calls were emitted (e.g. MALFORMED_FUNCTION_CALL means the args
  // are junk).
  if (TERMINAL_BAIL_REASONS.has(finishReason)) {
    ctx.telemetry.outcome = 'error'
    ctx.telemetry.errorMessage = `finish=${finishReason}`
    ctx.opts.setStatus('error', `Stopped: ${finishReason}`)
    return { kind: 'done', outcome: 'error' }
  }

  return dispatchToolCallsForTurn(ctx, functionCalls, turnCount)
}

function throwIfAborted(ctx: LoopContext): void {
  if (!ctx.opts.abortController.signal.aborted) return
  ctx.telemetry.outcome = 'aborted'
  ctx.telemetry.abortReason = 'signal'
  throw new Error('aborted')
}

/** Charge one interaction against the per-session cap. Returns a `done` TurnResult on cap-exceeded; null otherwise so the caller continues. */
function chargeTurnBudget(ctx: LoopContext, turnCount: number): TurnResult | null {
  const charged = ctx.budget.consumeInteractions(1, `turn ${turnCount}`, ctx.log)
  if (charged.ok) return null
  ctx.telemetry.outcome = 'session-cap-exceeded'
  ctx.telemetry.errorMessage = charged.message
  ctx.opts.setStatus('error', charged.message)
  return { kind: 'done', outcome: 'session-cap-exceeded' }
}

/** Open the LLM stream. Returns a tagged result so the caller can short-circuit on budget exhaustion without losing the throw vs typed-result distinction. */
async function openProviderStream(ctx: LoopContext): Promise<{ kind: 'stream', stream: AsyncIterable<StreamChunk> } | { kind: 'budget-exhausted' }> {
  try {
    const stream = await streamFromProvider({
      ai: ctx.opts.ai,
      model: ctx.opts.model,
      contents: ctx.contents,
      systemPrompt: ctx.opts.systemPrompt,
      toolDeclarations: ctx.toolDeclarations,
      abortSignal: ctx.opts.abortController.signal,
      thinkingBudget: ctx.thinkingBudget,
      virtualKey: ctx.opts.billingContext.virtualKey,
      chatProvider: ctx.opts.aiSession.aiProviders.chat,
      workspaceId: ctx.opts.aiSession.workspaceId ?? null,
      initiatorUserId: ctx.opts.aiSession.initiatorUserId ?? null,
      docId: ctx.opts.aiSession.docId ?? null
    })
    return { kind: 'stream', stream }
  } catch (e) {
    if (e instanceof LitellmBudgetExhausted || isBudgetExceededError(e)) {
      ctx.telemetry.outcome = 'budget-exhausted'
      ctx.telemetry.errorMessage = e instanceof Error ? e.message : String(e)
      emitBudgetBreadcrumb(ctx, ctx.opts.billingContext.plan)
      return { kind: 'budget-exhausted' }
    }
    throw e
  }
}

/**
 * Walk the model's tool calls, dispatch each, and build the single
 * user message whose parts are the functionResponse entries (the
 * continuation contract). Comment-trigger sessions terminate after
 * the trigger thread reply lands but still process all calls in the
 * current turn — a follow-up `replace_text` after `reply_to_comment`
 * should still execute its doc edit even though the loop will end.
 */
async function dispatchToolCallsForTurn(
  ctx: LoopContext,
  functionCalls: FunctionCall[],
  turnCount: number
): Promise<TurnResult> {
  const responseParts: NonNullable<Content['parts']> = []
  let commentTriggerDone = false

  for (const call of functionCalls) {
    throwIfAborted(ctx)
    const outcome = await dispatchToolCall(ctx, call)
    if (outcome.kind === 'session-cap-exceeded') {
      ctx.telemetry.outcome = 'session-cap-exceeded'
      ctx.telemetry.errorMessage = outcome.message
      ctx.opts.setStatus('error', outcome.message)
      return { kind: 'done', outcome: 'session-cap-exceeded' }
    }
    responseParts.push(...outcome.responseParts)
    if (outcome.kind === 'comment-trigger-done') commentTriggerDone = true
  }

  if (commentTriggerDone) {
    ctx.log(`turn ${turnCount}: reply_to_comment landed on trigger thread — terminating comment-trigger loop`)
    ctx.telemetry.outcome = 'success'
    ctx.opts.setStatus('done', 'Done')
    return { kind: 'done', outcome: 'success' }
  }

  const progress = ctx.progress.endTurn()
  if (progress.shouldStop) {
    // The model keeps editing without changing anything: blank lines,
    // no-op replacements, undoing its own edits. Its real work (if any)
    // is already in the document — end like a normal finish instead of
    // burning turns into the turn-limit error.
    ctx.log(`turn ${turnCount}: ${progress.consecutiveStalledTurns} turns in a row without real edits (limit ${STALLED_TURN_LIMIT}) — ending session`)
    ctx.telemetry.outcome = 'stalled'
    ctx.opts.setStatus('done', 'Done')
    return { kind: 'done', outcome: 'stalled' }
  }

  if (responseParts.length === 0) {
    // Shouldn't happen (we had functionCalls above) but guard against
    // a pathological case where all names were unset.
    ctx.log('no function responses to send; ending loop defensively')
    ctx.telemetry.outcome = 'success'
    ctx.opts.setStatus('done', 'Done')
    return { kind: 'done', outcome: 'success' }
  }

  ctx.contents.push({ role: 'user', parts: responseParts })
  return { kind: 'continue' }
}

export async function runAgenticLoop(opts: RunLoopOptions): Promise<void> {
  const log = opts.logger ?? ((msg: string) => console.log(`[ai/prompt ${opts.sessionId}] ${msg}`))
  const ctx: LoopContext = {
    opts,
    log,
    budget: new SessionBudget(),
    telemetry: new SessionTelemetry(),
    contents: [{ role: 'user', parts: [{ text: opts.initialPrompt }] }],
    // BYOK: hide tools the session's providers can't serve (no image
    // provider → no generate_image; text-only chat model → no
    // view_image / view_pages).
    toolDeclarations: filterToolsForProviders(opts.toolDeclarations ?? ALL_TOOL_DECLARATIONS, opts.aiSession.aiProviders, getWebToolAvailability()),
    thinkingBudget: opts.thinkingBudget ?? 0,
    progress: new EditProgressTracker(readDocText(opts.aiSession)),
    editedDocument: false,
    answeredUser: false
  }

  log(`[billing] session resolved: ${opts.billingContext.attributedTo} plan=${opts.billingContext.plan} virtualKey=…${opts.billingContext.virtualKey.slice(-6)}`)

  let turns = 0
  try {
    while (turns < MAX_TURNS) {
      turns += 1
      ctx.telemetry.turnCount = turns

      const result = await runOneTurn(ctx, turns)
      if (result.kind === 'done' || result.kind === 'budget-exhausted') return
    }

    // Ran out of turns.
    ctx.telemetry.outcome = 'turn-limit'
    ctx.telemetry.errorMessage = `Hit turn limit (${MAX_TURNS})`
    opts.setStatus('error', 'Hit turn limit')
  } catch (e) {
    // If the loop body already classified the throw (abort) leave the
    // outcome alone; otherwise stamp the message so the telemetry event
    // groups on it.
    if (ctx.telemetry.outcome === 'error') {
      ctx.telemetry.errorMessage = e instanceof Error ? e.message : String(e)
    }
    throw e
  } finally {
    ctx.telemetry.emit({
      sessionId: opts.sessionId,
      aiSession: opts.aiSession,
      plan: opts.billingContext.plan,
      attributedTo: opts.billingContext.attributedTo,
      totalInteractions: ctx.budget.totalInteractions()
    })
  }
}

// ─── Streaming dispatcher: production LiteLLM vs in-process test seam ───
//
// Two paths:
//
//   (1) LITELLM (production). Hit when `opts.ai` is undefined —
//       production callers omit it. Routes through `streamFromLiteLLM`
//       → OpenAI SDK → LiteLLM proxy → Mistral.
//
//   (2) TEST SEAM. Hit when `opts.ai` is explicitly injected. Tests
//       hand the loop a fake `AgenticAIClient` whose
//       `models.generateContentStream` yields scripted internal-shape
//       chunks. Skips the OpenAI-shape translation in
//       `messageTranslation.ts` — that translation is pinned
//       independently by `messageTranslation.test.ts`.

interface StreamFromProviderOpts {
  ai?: AiClient
  model: string
  contents: Content[]
  systemPrompt: string
  toolDeclarations: FunctionDeclaration[]
  abortSignal: AbortSignal
  thinkingBudget: number
  virtualKey: string
  /** Resolved chat provider (BYOK / instance default). Null → the call fails with a settings hint. */
  chatProvider: ResolvedAiProvider | null
  workspaceId?: string | null
  initiatorUserId?: number | null
  docId?: string | null
}

async function streamFromProvider(opts: StreamFromProviderOpts): Promise<AsyncIterable<StreamChunk>> {
  if (!opts.ai) {
    return await streamFromLiteLLM(opts)
  }
  return await opts.ai.models.generateContentStream({
    model: opts.model,
    contents: opts.contents,
    config: {
      systemInstruction: opts.systemPrompt,
      tools: [{ functionDeclarations: opts.toolDeclarations }],
      abortSignal: opts.abortSignal
    }
  })
}

async function streamFromLiteLLM(opts: StreamFromProviderOpts): Promise<AsyncIterable<StreamChunk>> {
  // BYOK: the chat provider was resolved at session start (user key →
  // instance default). `providerRequestFields` re-checks the base URL
  // against the SSRF policy on every turn and yields either
  // `byok/<model>` + clientside credentials (zero-cost deployment) or a
  // platform model alias.
  const provider = opts.chatProvider
  if (!provider) throw new Error('No AI chat provider is configured. Add your API key in Settings → AI provider.')
  const litellm = useLitellmForUser(opts.virtualKey)
  const providerFields = await providerRequestFields(provider)

  const messages = internalToOpenAIMessages(opts.systemPrompt, opts.contents)
  const tools = internalToOpenAITools(opts.toolDeclarations)

  // `stream_options.include_usage: true` makes Mistral emit token usage
  // on the final chunk so our existing `usageMetadata` accumulator
  // catches it.
  const oaiStream = await withProviderErrors(provider, () => litellmStream(litellm, {
    ...providerFields,
    messages,
    tools: tools.length > 0 ? tools : undefined,
    tool_choice: tools.length > 0 ? 'auto' : undefined,
    stream: true,
    stream_options: { include_usage: true },
    // Temperature 0 — the agentic loop is deterministic-tool-selection.
    // Default Mistral sampling (~0.7) made tool choice vary run-to-run
    // and thrashed flow tests. Synthesis sub-calls already run at 0;
    // pinning the outer loop matches that.
    temperature: 0,
    // Mistral prompt caching is AUTOMATIC on a stable prompt prefix (cached
    // tokens bill at 10%). The win comes from keeping the system+tools prefix
    // byte-identical across turns and successive prompts — set up by the
    // static-first system-prompt ordering in prompt.post.ts. Verified through
    // the proxy: cached_tokens reaches ~98% of prompt_tokens on warm requests
    // (~88% input-cost cut). Caching does NOT require the key below.
    //
    // `prompt_cache_key` (keyed on docId to group every turn/prompt/user on a
    // doc) is future-proofing: it would warm the cache a request sooner. But
    // LiteLLM 1.83.14 drops it on the mistral provider (traced end-to-end,
    // even with allowed_openai_params in config.yaml), so it's a harmless
    // no-op today that activates on a LiteLLM upgrade that forwards it.
    ...(opts.docId ? { prompt_cache_key: `doc:${opts.docId}` } : {}),
    // LiteLLM spend-tags: feature, workspace (when the doc is in one),
    // and the initiating user. Sub-tool synthesis calls
    // (web_search/fetch_url) inside this loop carry the same tag set
    // so the workspace breakdown stays consistent.
    ...featureMetadata(FEATURE_TAGS.textLoop, {
      workspaceId: opts.workspaceId,
      userId: opts.initiatorUserId,
      docId: opts.docId
    })
  }, { signal: opts.abortSignal }))

  // BYOK: errors raised WHILE the stream is consumed (a provider SSE
  // error event, a dropped connection) bypass `withProviderErrors` above,
  // which only covers opening the stream. Wrap the iteration too so a
  // provider that echoes the key mid-stream can't leak it into the
  // status channel, logs or Sentry.
  return openAIStreamToInternalChunks(redactProviderStream(provider, oaiStream))
}
