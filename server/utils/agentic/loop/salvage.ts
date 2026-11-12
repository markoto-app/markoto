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
  if (isCommentTriggerSession(ctx)) return false
  return ctx.editedDocument || ctx.answeredUser
}

function collectProseText(modelParts: ResponseParts): string {
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
  const isCommentTrigger = isCommentTriggerSession(ctx)
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
