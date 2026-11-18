import { aiStatus } from '~~/shared/ai/statusSteps'
import { AI_SESSION_WRAP_UP_MARGIN_MS } from '../limits'
import { isCommentTriggerSession, throwIfAborted, type LoopContext, type WrapUpReason } from './loopContext'
import { streamTurn, type StreamedTurn } from './providerStream'
import { collectProseText, dispatchSalvageFallback } from './salvage'
import { dispatchToolCall } from './toolDispatch'

// The closing turn. When the loop has to stop before the model finished
// (turn limit, deadline close, responses that keep hitting the output
// token limit) it asks the model once more, with the SAME tool list (the
// cached prompt prefix stays valid) and `tool_choice` forcing the closing
// tool, to tell the user what is done and what is not. The user gets that
// message instead of a bare "stopped" error; the session outcome still
// records why it stopped.

/** Less than `AI_SESSION_WRAP_UP_MARGIN_MS` left before the session's hard deadline. */
export function nearDeadline(ctx: LoopContext): boolean {
  const deadlineAt = ctx.opts.deadlineAt
  if (deadlineAt === undefined) return false
  const now = (ctx.opts.now ?? Date.now)()
  return deadlineAt - now < AI_SESSION_WRAP_UP_MARGIN_MS
}

const REASON_TEXT: Record<WrapUpReason, string> = {
  'turn-limit': 'Step limit reached.',
  'time-limit': 'Time limit almost reached.',
  'output-limit': 'Your responses keep hitting the output token limit, so this session stops here.'
}

function closingToolOf(ctx: LoopContext): 'reply_to_comment' | 'message_to_user' {
  return isCommentTriggerSession(ctx) ? 'reply_to_comment' : 'message_to_user'
}

/** The instruction appended to the conversation for the closing turn. */
function wrapUpInstruction(ctx: LoopContext, reason: WrapUpReason): string {
  const how = isCommentTriggerSession(ctx)
    ? `Call reply_to_comment on comment_id "${ctx.opts.commentThreadId}" now`
    : 'Call message_to_user now'
  return `${REASON_TEXT[reason]} Do not call any other tool. ${how} and tell the user in one or two sentences what is done and what is not.`
}

/** Append `text` to the pending user message (the last tool results), or open one. */
function appendUserNote(ctx: LoopContext, text: string): void {
  const last = ctx.contents.at(-1)
  if (last?.role === 'user') {
    last.parts = [...(last.parts ?? []), { text }]
    return
  }
  ctx.contents.push({ role: 'user', parts: [{ text }] })
}

/** A 4xx at open with a forced tool: the provider does not take a named `tool_choice`. */
function rejectsNamedToolChoice(ctx: LoopContext, e: unknown): boolean {
  if (ctx.opts.abortController.signal.aborted) return false
  const status = typeof e === 'object' && e !== null ? (e as { status?: unknown }).status : undefined
  return status === 400 || status === 422
}

async function streamClosingTurn(ctx: LoopContext, closingTool: string): Promise<{ kind: 'turn', turn: StreamedTurn } | { kind: 'budget-exhausted' }> {
  if (!ctx.toolDeclarations.some(d => d.name === closingTool)) return streamTurn(ctx, { phase: 'closing' })
  try {
    return await streamTurn(ctx, { forceFunction: closingTool, phase: 'closing' })
  } catch (e) {
    if (!rejectsNamedToolChoice(ctx, e)) throw e
    // Some providers / BYOK endpoints reject a named tool_choice; the
    // appended instruction still asks for the closing call.
    ctx.log(`closing turn: provider rejected the forced tool_choice, retrying with auto`)
    return streamTurn(ctx, { phase: 'closing' })
  }
}

type ClosingResult = 'delivered' | 'not-delivered' | 'handled'

async function runClosingTurn(ctx: LoopContext, reason: WrapUpReason, turnCount: number): Promise<ClosingResult> {
  const charged = ctx.budget.consumeInteractions(1, `turn ${turnCount} (closing)`, ctx.log)
  if (!charged.ok) return 'not-delivered'
  throwIfAborted(ctx)
  ctx.opts.setStatus('thinking', aiStatus('thinking'))
  const closingTool = closingToolOf(ctx)
  appendUserNote(ctx, wrapUpInstruction(ctx, reason))

  const streamed = await streamClosingTurn(ctx, closingTool)
  // The budget refusal already set the status and outcome.
  if (streamed.kind === 'budget-exhausted') return 'handled'
  const { modelParts, functionCalls } = streamed.turn
  ctx.contents.push({ role: 'model', parts: modelParts })

  // Only the closing tool runs: the session is over, nothing else may
  // edit the document or reach beyond it now.
  let delivered = false
  for (const call of functionCalls.filter(c => c.name === closingTool)) {
    throwIfAborted(ctx)
    const outcome = await dispatchToolCall(ctx, call)
    if (outcome.kind === 'comment-trigger-done') delivered = true
    if (outcome.kind === 'continue' && outcome.responseParts.some(p => p.functionResponse?.response?.isError === false)) delivered = true
  }
  if (!delivered && functionCalls.length === 0) {
    const prose = collectProseText(modelParts)
    if (prose.length > 0) delivered = await dispatchSalvageFallback(ctx, prose, turnCount)
  }
  return delivered ? 'delivered' : 'not-delivered'
}

/**
 * Stop the session for `reason` with one closing turn. Records the
 * outcome; the user sees the model's summary (status `done`) or, when no
 * summary arrived, the turn-limit error.
 */
export async function wrapUpSession(ctx: LoopContext, reason: WrapUpReason, turnCount: number): Promise<void> {
  ctx.log(`turn ${turnCount}: stopping (${reason}), closing turn`)
  ctx.telemetry.turnCount = turnCount
  let result: ClosingResult
  try {
    result = await runClosingTurn(ctx, reason, turnCount)
  } catch (e) {
    if (ctx.opts.abortController.signal.aborted) throw e
    ctx.log(`closing turn failed: ${e instanceof Error ? e.message : String(e)}`)
    result = 'not-delivered'
  }
  if (result === 'handled') return
  ctx.telemetry.outcome = reason
  ctx.telemetry.errorMessage = `Stopped: ${reason}`
  if (result === 'delivered') ctx.opts.setStatus('done', aiStatus('done'))
  else ctx.opts.setStatus('error', aiStatus('turnLimit'))
}
