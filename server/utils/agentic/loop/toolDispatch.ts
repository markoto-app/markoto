import type { AgenticFunctionCall as FunctionCall } from '../aiTypes'
import { executeFunctionByName, toolSchema } from '../../ai/tools/registry'
import type { ToolResult } from '../../ai/tools/toolDefinition'
import { DOC_EDIT_TOOLS, NO_OP_EDIT_ERROR_PREFIX, stalledEditNote } from '../editProgress'
import { unseenImageError } from '../imageProvenance'
import { readDocText, throwIfAborted, toolErrorResponse, isCommentTriggerSession, type DispatchOutcome, type LoopContext, type ResponseParts } from './loopContext'
import { logToolActivity } from './toolActivity'
import { runSubCall } from './webSubCalls'

// One tool call of a turn, in a fixed order: offered? → valid arguments →
// conversation memory → per-tool cap → taint gate → image provenance (doc
// edits) → run → taint / provenance / edit-progress bookkeeping → the
// functionResponse part(s) for the next turn.

/** Text a `replace_text` / `insert_text` call would add to the document. */
function addedEditText(args: unknown): string {
  if (typeof args !== 'object' || args === null) return ''
  const fields = args as Record<string, unknown>
  const added = fields.new_str ?? fields.insert_text
  return typeof added === 'string' ? added : ''
}

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
  const schema = toolSchema(call.name ?? '')
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
 * lands as a verbatim row, not a compacted tool_call row, skip here
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
 * Per-tool call-count cap. Independent of the per-user budget,
 * protects a single session from runaway loops on cost-amplifying
 * tools. Returns `null` when the slot is claimed; otherwise a
 * `continue` outcome with a tool-error response so the model wraps
 * up gracefully without further tool use.
 */
function checkToolSlotCap(ctx: LoopContext, call: FunctionCall): DispatchOutcome | null {
  const name = call.name ?? ''
  if (ctx.budget.claimToolSlot(name)) return null
  const cap = ctx.budget.toolCap(name) ?? 0
  ctx.log(`[limits] tool call cap reached: ${call.name} (${cap}/${cap})`)
  return {
    kind: 'continue',
    responseParts: [toolErrorResponse(call, `Tool call limit reached for ${call.name} (${cap}). Wrap up your response.`)]
  }
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
    if (!result.isError) logToolActivity(ctx, name, validatedArgs)
    return { kind: 'ok', result }
  } catch (e: unknown) {
    if (ctx.opts.abortController.signal.aborted) throw e
    const msg = e instanceof Error ? e.message : 'Unknown error'
    ctx.log(`function_call threw: ${name}: ${msg}`)
    return { kind: 'ok', result: { content: `Error: ${name} failed: ${msg}`, isError: true } }
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

/** Only tools offered to this session may run. */
function refuseUnofferedTool(ctx: LoopContext, call: FunctionCall): DispatchOutcome | null {
  // e.g. the knowledge tools are not offered without workspace membership
  // + ready files, and a model that names them anyway must not reach the
  // handler.
  if (ctx.toolDeclarations.some(d => d.name === call.name)) return null
  ctx.log(`function_call refused: ${call.name} is not offered in this session`)
  return { kind: 'continue', responseParts: [toolErrorResponse(call, `Error: tool ${call.name} is not available in this session.`)] }
}

/** A document edit may only add images whose URL this session has seen (`imageProvenance.ts`). */
function refuseUnseenImages(ctx: LoopContext, call: FunctionCall, validatedArgs: unknown, textBefore: string | null): DispatchOutcome | null {
  const unseen = ctx.imageProvenance.unseenImageUrls(addedEditText(validatedArgs), textBefore)
  if (unseen.length === 0) return null
  ctx.log(`function_call ${call.name} refused: image URL(s) not seen in this session: ${unseen.join(', ').slice(0, 200)}`)
  const canGenerate = ctx.toolDeclarations.some(d => d.name === 'generate_image')
  return { kind: 'continue', responseParts: [toolErrorResponse(call, unseenImageError(unseen, canGenerate))] }
}

/** Session bookkeeping after a tool ran: seen image URLs, taint state, a delivered answer. */
async function noteToolResult(ctx: LoopContext, name: string, validatedArgs: unknown, result: ToolResult): Promise<void> {
  if (!result.isError) ctx.imageProvenance.note(result.content)
  await ctx.opts.crossBoundary.afterTool(name, validatedArgs, result)
  if (!result.isError && name === 'message_to_user') ctx.answeredUser = true
}

/**
 * Classify a document edit's effect (`editProgress.ts`) and append the
 * stalled-edit note to the tool output when the edit changed nothing real.
 */
function noteEditProgress(ctx: LoopContext, call: FunctionCall, validatedArgs: unknown, textBefore: string | null, result: ToolResult): string {
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
  return note ? `${result.content}\n\n${note}` : result.content
}

function toolResponseParts(call: FunctionCall, output: string, result: ToolResult): ResponseParts {
  const responseParts: ResponseParts = [{
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
  return responseParts
}

/**
 * Comment-trigger terminator: a successful reply_to_comment on the
 * trigger thread ends the session. Mistral occasionally emits both
 * reply_to_comment AND a hallucinated follow-up tool call, without this
 * the rainbow ring stays lit on the orphaned call until
 * SESSION_INTERACTION_CAP / MAX_TURNS.
 */
function repliedToTriggerThread(ctx: LoopContext, name: string, validatedArgs: unknown, result: ToolResult): boolean {
  if (!isCommentTriggerSession(ctx) || name !== 'reply_to_comment' || result.isError) return false
  const a = validatedArgs as { comment_id?: unknown }
  return typeof a.comment_id === 'string' && a.comment_id === ctx.opts.commentThreadId
}

export async function dispatchToolCall(
  ctx: LoopContext,
  call: FunctionCall
): Promise<DispatchOutcome> {
  if (!call.name) return { kind: 'continue', responseParts: [] }

  // Telemetry tally: every attempted invocation, including
  // cap-rejected and errored.
  ctx.telemetry.noteToolAttempt(call.name)
  // Argument NAMES only: the values are document text and user prompts.
  ctx.log(`function_call: ${call.name} args=${Object.keys(call.args ?? {}).join(',')}`)

  const refused = refuseUnofferedTool(ctx, call)
  if (refused) return refused

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
  const unseenImages = isDocEdit ? refuseUnseenImages(ctx, call, validatedArgs, textBefore) : null
  if (unseenImages) return unseenImages

  const runResult = await runOneTool(ctx, call.name, validatedArgs)
  if (runResult.kind === 'session-cap-exceeded') return runResult
  const result = runResult.result
  await noteToolResult(ctx, call.name, validatedArgs, result)

  const output = isDocEdit ? noteEditProgress(ctx, call, validatedArgs, textBefore, result) : result.content
  const responseParts = toolResponseParts(call, output, result)
  return repliedToTriggerThread(ctx, call.name, validatedArgs, result)
    ? { kind: 'comment-trigger-done', responseParts }
    : { kind: 'continue', responseParts }
}
