import {
  FinishReason,
  type Content,
  type FunctionCall,
  type FunctionDeclaration,
  type GoogleGenAI
} from '@google/genai'
import type { AiSession } from '../aiClient'
import type { BillingContext } from '../billing'
import { chargeInteractions, BudgetExhausted } from '../billing'
import { executeFunctionByName } from '../aiToolAdapter'
import { ALL_TOOL_DECLARATIONS, TOOL_SCHEMAS, webSearch, fetchUrl } from './functionTools'
import {
  newStreamState,
  processChunk,
  type StreamStatusPhase
} from './streamStatus'

/**
 * The agentic loop: call Gemini with streaming + function calling, dispatch
 * any client-side tool invocations, loop until the model emits a plain text
 * response (no function calls) or we hit a stop condition.
 *
 * Contract:
 *   - Returns normally on `finishReason === STOP` with no function calls.
 *   - Throws on abort — caller distinguishes abort vs real error via
 *     `abortController.signal.aborted` in its own catch block.
 *   - Emits `setStatus(...)` at every state transition.
 *
 * Each turn either wants tools (functionCalls present) or is terminal.
 */

const MAX_TURNS = 20

export interface RunLoopOptions {
  ai: GoogleGenAI
  model: string
  systemPrompt: string
  initialPrompt: string
  aiSession: AiSession
  sessionId: string
  abortController: AbortController
  setStatus: (phase: StreamStatusPhase, message?: string) => void
  /**
   * Tokens the model may spend on internal reasoning per turn. 0 = thinking
   * disabled (cheapest + fastest). Only passed through when > 0 — Gemini
   * models that don't support thinkingConfig (e.g. older flash-lite) error
   * when they see an empty thinkingConfig, so we omit the key entirely for
   * the disabled case.
   */
  thinkingBudget?: number
  /**
   * Override the function declarations handed to Gemini. Defaults to
   * `ALL_TOOL_DECLARATIONS`. Callers that want additional tools (e.g.
   * knowledge-base access for workspace docs) pass
   * `[...ALL_TOOL_DECLARATIONS, ...KNOWLEDGE_TOOL_DECLARATIONS]`.
   */
  toolDeclarations?: FunctionDeclaration[]
  /**
   * Billing context for the session (who gets charged, what plan
   * caps apply). Drives per-turn and per-sub-call interaction
   * charges. Absent only in exceptional test paths that bypass the
   * billing resolver.
   */
  billingContext?: BillingContext
  /** Optional logger — defaults to `console.log` tagged with the session id. */
  logger?: (msg: string) => void
}

export async function runAgenticLoop(opts: RunLoopOptions): Promise<void> {
  const {
    ai, model, systemPrompt, initialPrompt,
    aiSession, sessionId, abortController, setStatus
  } = opts
  const log = opts.logger ?? ((msg: string) => console.log(`[ai/prompt ${sessionId}] ${msg}`))
  const thinkingBudget = opts.thinkingBudget ?? 0
  const toolDeclarations = opts.toolDeclarations ?? ALL_TOOL_DECLARATIONS
  const billingContext = opts.billingContext

  // Interaction charging. Every AI call site debits the counter
  // before we incur cost. A mid-loop BudgetExhausted terminates
  // the run with a doc breadcrumb instead of a hard throw — users
  // MUST see an explanation in the doc since there's no chat UI.
  const charge = async (delta: number, reason: string): Promise<void> => {
    if (!billingContext) return // prompt.post always passes one; defensive guard.
    const { attributedTo, plan, periodStart } = billingContext
    const result = await chargeInteractions({ attributedTo, plan, delta, periodStart, reason })
    log(`[billing] charged ${attributedTo} plan=${plan} delta=${delta} (${reason}; used=${result.used}/${result.used + result.remaining})`)
  }
  if (billingContext) {
    log(`[billing] session resolved: ${billingContext.attributedTo} plan=${billingContext.plan} remaining=${billingContext.interactionsRemaining}`)
  }

  /**
   * Graceful mid-loop exhaustion handler. Writes an upgrade breadcrumb
   * into the Y.Doc via the same transaction origin the other tools
   * use, so it participates in undo/redo + the normal awareness flow.
   * Returning vs throwing: we RETURN so the outer try/finally in
   * prompt.post runs cleanup, tears down the AI session, and logs
   * "aborted" rather than an unhandled error.
   */
  const emitBudgetBreadcrumb = (err: BudgetExhausted): void => {
    const msg = `\n\n_AI budget exhausted for this billing period (plan: ${err.plan}). [Upgrade your plan](/pricing) to continue._\n`
    try {
      aiSession.ydoc.transact(() => {
        aiSession.ytext.insert(aiSession.ytext.length, msg)
      }, `ai:assistant:${sessionId}`)
    } catch (e) {
      log(`failed to write budget-exhausted breadcrumb: ${e instanceof Error ? e.message : e}`)
    }
    setStatus('done', 'Budget exhausted')
  }

  // Manual `contents` history. Each turn:
  //   - push `{ role: 'model', parts: [...] }` with whatever the model returned
  //   - push `{ role: 'user', parts: [functionResponse, ...] }` with our tool results
  const contents: Content[] = [
    { role: 'user', parts: [{ text: initialPrompt }] }
  ]

  let turns = 0

  while (turns < MAX_TURNS) {
    if (abortController.signal.aborted) throw new Error('aborted')
    turns += 1

    setStatus('thinking', 'Thinking…')
    log(`turn ${turns}: calling Gemini (${contents.length} messages)`)
    // Charge 1 interaction per turn, upfront. Grounded turns that
    // call web_search/fetch_url later pay an ADDITIONAL 4 (net=5);
    // we can't know until after the model response whether this turn
    // will be grounded, and charging upfront keeps the accounting
    // monotonic (you never owe more than you've already paid). If
    // the turn ends up grounded, the sub-call adds 4 to reach the
    // documented 5 total.
    try {
      await charge(1, `turn ${turns}`)
    } catch (e) {
      if (e instanceof BudgetExhausted) {
        emitBudgetBreadcrumb(e)
        return
      }
      throw e
    }

    const stream = await ai.models.generateContentStream({
      model,
      contents,
      config: {
        systemInstruction: systemPrompt,
        tools: [{ functionDeclarations: toolDeclarations }],
        abortSignal: abortController.signal,
        // Only pass thinkingConfig when the operator actually opted in.
        // Models without thinking support (e.g. some flash-lite variants)
        // reject `thinkingConfig: { thinkingBudget: 0 }` with a schema
        // error, so we omit the key entirely for the disabled case.
        ...(thinkingBudget > 0 ? { thinkingConfig: { thinkingBudget } } : {})
      }
    })

    // Per-turn state: status dedupe + accumulation of the model's own reply so
    // we can append it to `contents` on continuation.
    const streamState = newStreamState()
    const modelParts: NonNullable<Content['parts']> = []
    const functionCalls: FunctionCall[] = []
    let finishReason: FinishReason | undefined

    for await (const chunk of stream) {
      if (abortController.signal.aborted) throw new Error('aborted')

      // Status announcements (derived from functionCalls in this chunk).
      processChunk(chunk, streamState, { setStatus, logger: log })

      // Accumulate model output so we can append it to `contents` verbatim
      // if the turn continues. Gemini splits one logical response across
      // multiple chunks; each chunk contributes parts for the same candidate.
      const parts = chunk.candidates?.[0]?.content?.parts
      if (parts) modelParts.push(...parts)

      const calls = chunk.functionCalls
      if (calls?.length) functionCalls.push(...calls)

      const reason = chunk.candidates?.[0]?.finishReason
      if (reason) finishReason = reason
    }

    log(`turn ${turns}: finishReason=${finishReason}, parts=${modelParts.length}, calls=${functionCalls.length}`)

    // Record the model's response so the next turn (if any) has full history.
    // Gemini requires the model's Content block to be present before the
    // corresponding functionResponse user block.
    contents.push({ role: 'model', parts: modelParts })

    // No function calls → natural end of conversation (plain text response).
    if (functionCalls.length === 0) {
      if (finishReason && finishReason !== FinishReason.STOP && finishReason !== FinishReason.MAX_TOKENS) {
        // Safety / recitation / malformed — surface as error.
        setStatus('error', `Stopped: ${finishReason}`)
      } else {
        setStatus('done', 'Done')
      }
      return
    }

    // Terminal non-STOP finishReasons we should still bail on, even if calls
    // were emitted (e.g. MALFORMED_FUNCTION_CALL means the args are junk).
    if (
      finishReason === FinishReason.MALFORMED_FUNCTION_CALL
      || finishReason === FinishReason.UNEXPECTED_TOOL_CALL
      || finishReason === FinishReason.SAFETY
      || finishReason === FinishReason.PROHIBITED_CONTENT
    ) {
      setStatus('error', `Stopped: ${finishReason}`)
      return
    }

    // Execute each function call in order; build a single user message whose
    // parts are the functionResponse entries (Gemini's continuation contract).
    const responseParts: NonNullable<Content['parts']> = []
    for (const call of functionCalls) {
      if (abortController.signal.aborted) throw new Error('aborted')
      if (!call.name) continue

      log(`function_call: ${call.name} args=${JSON.stringify(call.args).slice(0, 200)}`)

      // Validate args with the Zod schema registered for this tool. Gemini
      // *usually* returns args that match the declared schema, but not
      // guaranteed — malformed args used to silently coerce via defensive
      // `String()` / `Number()` casts. Now we surface them cleanly to the
      // model so it can retry with the correct shape.
      const schema = TOOL_SCHEMAS[call.name]
      let validatedArgs: unknown
      if (schema) {
        const parsed = schema.safeParse(call.args ?? {})
        if (!parsed.success) {
          const zodMsg = parsed.error.issues
            .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; ')
          log(`function_call validation failed: ${call.name}: ${zodMsg}`)
          responseParts.push({
            functionResponse: {
              id: call.id,
              name: call.name,
              response: {
                output: `Error: invalid arguments for ${call.name}: ${zodMsg}`,
                isError: true
              }
            }
          })
          continue
        }
        validatedArgs = parsed.data
      } else {
        // Unknown tool — let executeFunctionByName / webSearch branch handle
        // the "unsupported" error. Pass raw args through.
        validatedArgs = call.args ?? {}
      }

      let result: { content: string, isError: boolean, extraParts?: NonNullable<Content['parts']> }
      if (call.name === 'web_search') {
        // Safe cast — schema guarantees `{ query: string }`.
        const { query } = validatedArgs as { query: string }
        // Grounded sub-call → +4 to reach net=5 for this turn (1
        // already paid at turn start + 4 here = 5). Charged BEFORE
        // the Gemini sub-call so exhausted users don't incur cost.
        try {
          await charge(4, `web_search grounded sub-call (+4 to reach turn total of 5)`)
        } catch (e) {
          if (e instanceof BudgetExhausted) {
            emitBudgetBreadcrumb(e)
            return
          }
          throw e
        }
        try {
          const text = await webSearch(ai, model, query, abortController.signal)
          result = { content: text, isError: false }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : 'Unknown error'
          if (abortController.signal.aborted) throw e
          result = { content: `Error: web_search failed: ${msg}`, isError: true }
        }
      } else if (call.name === 'fetch_url') {
        // Schema guarantees `{ url: string }`. Routed here (not through
        // the adapter) because — like web_search — it's an async sub-call
        // that needs the GoogleGenAI client and runs `urlContext` in
        // isolation from our `functionDeclarations`.
        const { url } = validatedArgs as { url: string }
        try {
          await charge(4, `fetch_url grounded sub-call (+4 to reach turn total of 5)`)
        } catch (e) {
          if (e instanceof BudgetExhausted) {
            emitBudgetBreadcrumb(e)
            return
          }
          throw e
        }
        try {
          const text = await fetchUrl(ai, model, url, abortController.signal)
          result = { content: text, isError: false }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : 'Unknown error'
          if (abortController.signal.aborted) throw e
          result = { content: `Error: fetch_url failed: ${msg}`, isError: true }
        }
      } else {
        try {
          result = await executeFunctionByName(aiSession, call.name, validatedArgs)
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : 'Unknown error'
          if (abortController.signal.aborted) throw e
          log(`function_call threw: ${call.name}: ${msg}`)
          result = { content: `Error: ${call.name} failed: ${msg}`, isError: true }
        }
      }

      responseParts.push({
        functionResponse: {
          id: call.id,
          name: call.name,
          // Gemini's SDK expects a Record here. We wrap into `{ output, ... }`
          // so the model sees a consistent shape; include isError so it can
          // react (e.g. try a different old_str if replace_text failed).
          response: { output: result.content, isError: result.isError }
        }
      })
      // Tools that return non-JSON payloads (view_image → inlineData) smuggle
      // them out as sibling parts on the same user message. Must come AFTER
      // the functionResponse so the model links them to the right call.
      if (result.extraParts?.length) responseParts.push(...result.extraParts)
    }

    if (responseParts.length === 0) {
      // Shouldn't happen (we had functionCalls above) but guard against
      // a pathological case where all names were unset.
      log('no function responses to send; ending loop defensively')
      setStatus('done', 'Done')
      return
    }

    contents.push({ role: 'user', parts: responseParts })
  }

  // Ran out of turns.
  setStatus('error', 'Hit turn limit')
}
