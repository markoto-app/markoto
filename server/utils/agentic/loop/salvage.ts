import { aiStatus } from '~~/shared/ai/statusSteps'
import { AgenticFinishReason as FinishReason } from '../aiTypes'
import { executeFunctionByName } from '../../ai/tools/registry'
import { isCommentTriggerSession, type LoopContext, type ResponseParts } from './loopContext'

/** Schema cap on the synthesised salvage `message_to_user.message` field. */
const SALVAGE_MESSAGE_MAX = 600

/**
 * Salvage path for turns where the model emitted prose with no tool
 * call. The system prompt forbids this, but Mistral drifts. Without a
 * salvage path the user sees nothing.
 *
 * Fork by session shape: comment-trigger sessions synthesise a
 * `reply_to_comment` against the originating thread; everyone else
 * synthesises `message_to_user(is_question=false)`.
 */
export async function salvageProseTurn(
  ctx: LoopContext,
  modelParts: ResponseParts,
  finishReason: FinishReason | undefined,
  turnCount: number
): Promise<void> {
  const proseText = collectProseText(modelParts)
  if (proseText.length > 0) {
    if (closingTextIsRedundant(ctx)) {
      // The session already answered with `message_to_user`; this note
      // must not replace that answer.
      ctx.log(`turn ${turnCount}: finished; closing text not shown (${proseText.length} chars)`)
    } else {
      await dispatchSalvageFallback(ctx, proseText, turnCount)
    }
  }
  finalizeSalvageStatus(ctx, finishReason)
}

/**
 * Closing prose is salvaged unless the session already answered. After
 * edits it is the user's only account of what changed ("Renamed 25
 * occurrences."); dropping it left the prompt bar without an answer for
 * the session (staging, 2026-11-18). Comment-trigger sessions always
 * salvage, the thread reply is the deliverable, and a successful reply
 * already ended the loop.
 */
function closingTextIsRedundant(ctx: LoopContext): boolean {
  if (isCommentTriggerSession(ctx)) return false
  return ctx.answeredUser
}

export function collectProseText(modelParts: ResponseParts): string {
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
 * Resolves true when the message was delivered.
 */
export async function dispatchSalvageFallback(ctx: LoopContext, proseText: string, turnCount: number): Promise<boolean> {
  const message = proseText.length > SALVAGE_MESSAGE_MAX
    ? proseText.slice(0, SALVAGE_MESSAGE_MAX - 1) + '…'
    : proseText
  const isCommentTrigger = isCommentTriggerSession(ctx)
  const fallbackTool = isCommentTrigger ? 'reply_to_comment' : 'message_to_user'
  const fallbackArgs: Record<string, unknown> = isCommentTrigger
    ? { comment_id: ctx.opts.commentThreadId, body: message }
    : { message, is_question: false }
  ctx.log(`turn ${turnCount}: salvaging pure-prose response (${proseText.length} chars) via ${fallbackTool} fallback`)
  try {
    const result = await executeFunctionByName(ctx.opts.aiSession, fallbackTool, fallbackArgs)
    return !result.isError
  } catch (e) {
    ctx.log(`${fallbackTool} fallback failed: ${e instanceof Error ? e.message : e}`)
    return false
  }
}

function finalizeSalvageStatus(ctx: LoopContext, finishReason: FinishReason | undefined): void {
  if (finishReason && finishReason !== FinishReason.STOP && finishReason !== FinishReason.MAX_TOKENS) {
    ctx.telemetry.outcome = 'error'
    ctx.telemetry.errorMessage = `finish=${finishReason}`
    ctx.opts.setStatus('error', aiStatus('stoppedReason', { reason: String(finishReason) }))
  } else {
    ctx.telemetry.outcome = 'success'
    ctx.opts.setStatus('done', aiStatus('done'))
  }
}
