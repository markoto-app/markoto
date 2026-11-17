import { aiStatus } from '~~/shared/ai/statusSteps'
import {
  AgenticFinishReason as FinishReason,
  type AgenticFunctionCall as FunctionCall
} from './aiTypes'
import { getWebToolAvailability } from '../ai/webTools'
import { ALL_TOOL_DECLARATIONS, filterToolsForProviders } from '../ai/tools/registry'
import { EditProgressTracker, STALLED_TURN_LIMIT } from './editProgress'
import { ImageUrlProvenance } from './imageProvenance'
import { initialUserParts } from './promptAssembly'
import { useLogger } from '../platform/logger'
import { SessionBudget, sessionCapStatus } from './loop/sessionBudget'
import { SessionTelemetry } from './loop/sessionTelemetry'
import { readDocText, throwIfAborted, type LoopContext, type ResponseParts, type RunLoopOptions, type TurnResult } from './loop/loopContext'
import { consumeStreamTurn, openProviderStream } from './loop/providerStream'
import { salvageProseTurn } from './loop/salvage'
import { dispatchToolCall } from './loop/toolDispatch'

const loopLog = useLogger('ai-loop')

/**
 * The agentic loop: stream from the LLM (Mistral via LiteLLM) with
 * function calling, dispatch each tool call, loop until the model replies
 * without a tool call (its finish signal; prose is salvaged into one
 * closing tool call unless the session already edited the document or
 * answered the user) or we hit a stop condition, including
 * `STALLED_TURN_LIMIT` turns in a row whose edits changed nothing but
 * whitespace / reverted earlier edits (see `editProgress.ts`).
 *
 * Returns normally on STOP; throws on abort. Status transitions are
 * reported via setStatus(...) at every state change.
 */

const MAX_TURNS = 20

/**
 * Terminal non-STOP finishReasons that indicate the model gave up but
 * didn't end cleanly. We bail even if functionCalls were emitted,
 * MALFORMED_FUNCTION_CALL means the args are junk and re-trying would
 * just produce more junk.
 */
const TERMINAL_BAIL_REASONS: ReadonlySet<FinishReason | undefined> = new Set([
  FinishReason.MALFORMED_FUNCTION_CALL,
  FinishReason.UNEXPECTED_TOOL_CALL,
  FinishReason.SAFETY,
  FinishReason.PROHIBITED_CONTENT
])

async function runOneTurn(ctx: LoopContext, turnCount: number): Promise<TurnResult> {
  throwIfAborted(ctx)
  ctx.opts.setStatus('thinking', aiStatus('thinking'))
  ctx.log(`turn ${turnCount}: calling LLM (${ctx.contents.length} messages)`)

  const capResult = chargeTurnBudget(ctx, turnCount)
  if (capResult) return capResult

  const streamResult = await openProviderStream(ctx)
  if (streamResult.kind === 'budget-exhausted') return { kind: 'budget-exhausted' }

  const { modelParts, functionCalls, finishReason } = await consumeStreamTurn(streamResult.stream, ctx)
  ctx.log(`turn ${turnCount}: finishReason=${finishReason}, parts=${modelParts.length}, calls=${functionCalls.length}`)

  // Record the model's response so the next turn (if any) has full
  // history: the continuation contract requires the model's Content
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
    ctx.opts.setStatus('error', aiStatus('stoppedReason', { reason: String(finishReason) }))
    return { kind: 'done', outcome: 'error' }
  }

  return dispatchToolCallsForTurn(ctx, functionCalls, turnCount)
}

/** Charge one interaction against the per-session cap. Returns a `done` TurnResult on cap-exceeded; null otherwise so the caller continues. */
function chargeTurnBudget(ctx: LoopContext, turnCount: number): TurnResult | null {
  const charged = ctx.budget.consumeInteractions(1, `turn ${turnCount}`, ctx.log)
  if (charged.ok) return null
  ctx.telemetry.outcome = 'session-cap-exceeded'
  ctx.telemetry.errorMessage = charged.message
  ctx.opts.setStatus('error', sessionCapStatus())
  return { kind: 'done', outcome: 'session-cap-exceeded' }
}

/**
 * Walk the model's tool calls, dispatch each, and build the single
 * user message whose parts are the functionResponse entries (the
 * continuation contract). Comment-trigger sessions terminate after
 * the trigger thread reply lands but still process all calls in the
 * current turn: a follow-up `replace_text` after `reply_to_comment`
 * should still execute its doc edit even though the loop will end.
 */
async function dispatchToolCallsForTurn(
  ctx: LoopContext,
  functionCalls: FunctionCall[],
  turnCount: number
): Promise<TurnResult> {
  const responseParts: ResponseParts = []
  let commentTriggerDone = false

  for (const call of functionCalls) {
    throwIfAborted(ctx)
    const outcome = await dispatchToolCall(ctx, call)
    if (outcome.kind === 'session-cap-exceeded') {
      ctx.telemetry.outcome = 'session-cap-exceeded'
      ctx.telemetry.errorMessage = outcome.message
      ctx.opts.setStatus('error', sessionCapStatus())
      return { kind: 'done', outcome: 'session-cap-exceeded' }
    }
    if (outcome.kind === 'provider-unavailable') {
      ctx.telemetry.outcome = 'provider-unavailable'
      ctx.telemetry.errorMessage = outcome.message
      ctx.opts.setStatus('error', outcome.message)
      return { kind: 'done', outcome: 'provider-unavailable' }
    }
    responseParts.push(...outcome.responseParts)
    if (outcome.kind === 'comment-trigger-done') commentTriggerDone = true
  }

  if (commentTriggerDone) {
    ctx.log(`turn ${turnCount}: reply_to_comment landed on trigger thread, terminating comment-trigger loop`)
    ctx.telemetry.outcome = 'success'
    ctx.opts.setStatus('done', aiStatus('done'))
    return { kind: 'done', outcome: 'success' }
  }

  const progress = ctx.progress.endTurn()
  if (progress.shouldStop) {
    // The model keeps editing without changing anything: blank lines,
    // no-op replacements, undoing its own edits. Its real work (if any)
    // is already in the document, end like a normal finish instead of
    // burning turns into the turn-limit error.
    ctx.log(`turn ${turnCount}: ${progress.consecutiveStalledTurns} turns in a row without real edits (limit ${STALLED_TURN_LIMIT}), ending session`)
    ctx.telemetry.outcome = 'stalled'
    ctx.opts.setStatus('done', aiStatus('done'))
    return { kind: 'done', outcome: 'stalled' }
  }

  if (responseParts.length === 0) {
    // Shouldn't happen (we had functionCalls above) but guard against
    // a pathological case where all names were unset.
    ctx.log('no function responses to send; ending loop defensively')
    ctx.telemetry.outcome = 'success'
    ctx.opts.setStatus('done', aiStatus('done'))
    return { kind: 'done', outcome: 'success' }
  }

  ctx.contents.push({ role: 'user', parts: responseParts })
  return { kind: 'continue' }
}

export async function runAgenticLoop(opts: RunLoopOptions): Promise<void> {
  // Per-turn chatter: debug, so a production log carries the failures (their
  // own error lines) rather than every turn.
  const sessionLog = loopLog.with({ sessionId: opts.sessionId })
  const log = opts.logger ?? ((msg: string) => sessionLog.debug(msg))
  const ctx: LoopContext = {
    opts,
    log,
    budget: new SessionBudget(),
    telemetry: new SessionTelemetry(),
    contents: [{ role: 'user', parts: initialUserParts({ context: opts.promptContext, preamble: opts.promptPreamble }, opts.initialPrompt) }],
    // BYOK: hide tools the session's providers can't serve (no image
    // provider → no generate_image; text-only chat model → no
    // view_image / view_pages).
    toolDeclarations: filterToolsForProviders(opts.toolDeclarations ?? ALL_TOOL_DECLARATIONS, opts.aiSession.aiProviders, getWebToolAvailability()),
    thinkingBudget: opts.thinkingBudget ?? 0,
    progress: new EditProgressTracker(readDocText(opts.aiSession)),
    // Document + the user's request. NOT the system prompt: its examples
    // name the placeholder URLs the model must never embed.
    imageProvenance: new ImageUrlProvenance(readDocText(opts.aiSession), opts.initialPrompt),
    editedDocument: false,
    answeredUser: false
  }

  log(`[billing] session resolved: ${opts.billingContext.attributedTo} plan=${opts.billingContext.plan}`)

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
    opts.setStatus('error', aiStatus('turnLimit'))
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
