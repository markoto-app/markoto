import {
  FinishReason,
  type Content,
  type FunctionCall,
  type FunctionDeclaration,
  type GoogleGenAI
} from '@google/genai'
import * as Sentry from '@sentry/nuxt'
import type { AiSession } from '../aiClient'
import type { BillingContext } from '../billing'
import { chargeInteractions, BudgetExhausted } from '../billing'
import { executeFunctionByName } from '../aiToolAdapter'
import { ALL_TOOL_DECLARATIONS, TOOL_SCHEMAS, webSearch, fetchUrl } from './functionTools'
import { SESSION_INTERACTION_CAP, SESSION_TOOL_CALL_CAPS } from './limits'
import { appendActivity, pruneActivity, type ActivityMetadata } from '../../repos/activity'
import { docExists } from '../../repos/documents'
import {
  newStreamState,
  processChunk,
  type StreamStatusPhase
} from './streamStatus'

/**
 * Outcome categories surfaced to Sentry on session end. Indexed as a
 * tag (`outcome`) so dashboards can filter / count without parsing
 * extras. Order maps to the four exit paths inside the loop body plus
 * the two cap variants surfaced separately for alerting.
 */
type SessionOutcome
  = | 'success'
    | 'aborted'
    | 'error'
    | 'session-cap-exceeded'
    | 'budget-exhausted'
    | 'turn-limit'

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

/**
 * Thrown when a single session crosses `SESSION_INTERACTION_CAP`. The
 * outer turn-loop catches this and exits via `setStatus('error', …)`
 * — surfaces to the UI as a "stopped" state rather than a hard throw.
 * Distinct from `BudgetExhausted` (the per-user monthly cap) so the
 * billing breadcrumb path doesn't also fire here.
 */
class SessionCapExhausted extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionCapExhausted'
  }
}

/**
 * Emit an `ai.tool` activity row for a meta-tool the AI just used.
 * Limited to tools that don't surface in the Y.Doc state and would
 * otherwise be invisible to collaborators (web_search, fetch_url,
 * generate_image). Doc-mutating tools (replace_text, insert_text,
 * comment.*, theme/title updates) bubble through sync-server and emit
 * their own activity events; emitting here would double-count them.
 *
 * Fire-and-forget — failures must never block the agentic loop.
 */
async function logAiTool(docId: string, metadata: Extract<ActivityMetadata, { kind: 'ai.tool' }>): Promise<void> {
  try {
    if (!(await docExists(docId))) return
    await appendActivity({
      docId,
      userName: 'AI Assistant',
      action: 'ai.tool',
      metadata
    })
    await pruneActivity(docId)
  } catch (e) {
    console.warn('[runLoop] ai.tool activity log failed:', e instanceof Error ? e.message : e)
  }
}

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
   * charges.
   */
  billingContext: BillingContext
  /** Optional logger — defaults to `console.log` tagged with the session id. */
  logger?: (msg: string) => void
}

export async function runAgenticLoop(opts: RunLoopOptions): Promise<void> {
  const {
    ai, model, systemPrompt, initialPrompt,
    aiSession, sessionId, abortController, setStatus, billingContext
  } = opts
  const log = opts.logger ?? ((msg: string) => console.log(`[ai/prompt ${sessionId}] ${msg}`))
  const thinkingBudget = opts.thinkingBudget ?? 0
  const toolDeclarations = opts.toolDeclarations ?? ALL_TOOL_DECLARATIONS

  // Per-session safety counters. Independent of the per-user monthly
  // budget — these are runaway-loop guards that gate a SINGLE session
  // from cost-amplifying outliers (50+ interactions, or N+ calls to
  // image gen / search / etc.). See `limits.ts` for the rationale on
  // each ceiling. `SessionCapExhausted` propagates out of `charge()`
  // so the existing turn-loop catch path treats it the same as a
  // mid-loop billing error: emit setStatus('error', …) and exit.
  let interactionsThisSession = 0
  const toolCallCounts = new Map<string, number>()
  // Separate from the cap counter above. The cap counter only ticks
  // AFTER the cap-check passes (so a rejected call doesn't burn a slot);
  // the telemetry counter records EVERY attempted tool invocation —
  // capped, errored, or successful — so dashboards can see the full
  // tool-use shape of a session.
  const telemetryToolCounts = new Map<string, number>()

  // ── Telemetry accumulators (Item 1 — observability) ─────────────────
  // Stamped into a single `ai-session-completed` Sentry event from the
  // try/finally below. Every exit path (success / abort / error / cap)
  // funnels through the same emission so ops can answer "which sessions
  // cost the most?" without correlating Gemini billing logs by hand.
  const startedAt = Date.now()
  let turnCount = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalThinkingTokens = 0
  let sawAnyUsageMetadata = false
  let outcome: SessionOutcome = 'error'
  let abortReason: string | undefined
  let errorMessage: string | undefined

  // Interaction charging. Every AI call site debits the counter
  // before we incur cost. A mid-loop BudgetExhausted terminates
  // the run with a doc breadcrumb instead of a hard throw — users
  // MUST see an explanation in the doc since there's no chat UI.
  const charge = async (delta: number, reason: string): Promise<void> => {
    // Per-session cap: refuse to charge if THIS run would push
    // total interactions past the safety ceiling. We check BEFORE
    // hitting the DB so an exhausted session doesn't bump the
    // monthly counter further — the run is already off-rails.
    if (interactionsThisSession + delta > SESSION_INTERACTION_CAP) {
      log(`[limits] session interaction cap reached (${interactionsThisSession}+${delta} > ${SESSION_INTERACTION_CAP}); aborting`)
      throw new SessionCapExhausted(
        `Session interaction cap reached (${SESSION_INTERACTION_CAP}). The agentic loop ran too long; please try a more focused prompt.`
      )
    }
    const { attributedTo, plan, periodStart } = billingContext
    const result = await chargeInteractions({ attributedTo, plan, delta, periodStart, reason })
    interactionsThisSession += delta
    log(`[billing] charged ${attributedTo} plan=${plan} delta=${delta} (${reason}; used=${result.used}/${result.used + result.remaining}; session=${interactionsThisSession})`)
  }
  log(`[billing] session resolved: ${billingContext.attributedTo} plan=${billingContext.plan} remaining=${billingContext.interactionsRemaining}`)

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

  try {
    while (turns < MAX_TURNS) {
      if (abortController.signal.aborted) {
        outcome = 'aborted'
        abortReason = 'signal'
        throw new Error('aborted')
      }
      turns += 1
      turnCount = turns

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
          outcome = 'budget-exhausted'
          errorMessage = e.message
          emitBudgetBreadcrumb(e)
          return
        }
        if (e instanceof SessionCapExhausted) {
          outcome = 'session-cap-exceeded'
          errorMessage = e.message
          setStatus('error', e.message)
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
        if (abortController.signal.aborted) {
          outcome = 'aborted'
          abortReason = 'signal'
          throw new Error('aborted')
        }

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

        // Token usage rolls up in `usageMetadata` on the final chunk. The
        // SDK exposes promptTokenCount / candidatesTokenCount /
        // thoughtsTokenCount as optional ints (undefined when the model
        // doesn't surface them — older flash-lite preview revisions). We
        // sum across turns and surface -1 in the final telemetry payload
        // when no chunk ever carried usage data so dashboards can tell
        // "model didn't report" apart from "actually 0 tokens".
        const usage = chunk.usageMetadata
        if (usage) {
          sawAnyUsageMetadata = true
          if (typeof usage.promptTokenCount === 'number') totalInputTokens += usage.promptTokenCount
          if (typeof usage.candidatesTokenCount === 'number') totalOutputTokens += usage.candidatesTokenCount
          if (typeof usage.thoughtsTokenCount === 'number') totalThinkingTokens += usage.thoughtsTokenCount
        }
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
          outcome = 'error'
          errorMessage = `finish=${finishReason}`
          setStatus('error', `Stopped: ${finishReason}`)
        } else {
          outcome = 'success'
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
        outcome = 'error'
        errorMessage = `finish=${finishReason}`
        setStatus('error', `Stopped: ${finishReason}`)
        return
      }

      // Execute each function call in order; build a single user message whose
      // parts are the functionResponse entries (Gemini's continuation contract).
      const responseParts: NonNullable<Content['parts']> = []
      for (const call of functionCalls) {
        if (abortController.signal.aborted) {
          outcome = 'aborted'
          abortReason = 'signal'
          throw new Error('aborted')
        }
        if (!call.name) continue
        // Telemetry: per-tool attempt counts (independent of cap counter
        // — we want the FULL tally of attempted invocations, including
        // capped/skipped ones below).
        telemetryToolCounts.set(call.name, (telemetryToolCounts.get(call.name) ?? 0) + 1)

        log(`function_call: ${call.name} args=${JSON.stringify(call.args).slice(0, 200)}`)

        // Validate args with the Zod schema registered for this tool. Gemini
        // *usually* returns args that match the declared schema, but not
        // guaranteed — surface schema failures cleanly to the model so it
        // can retry with the correct shape rather than silently coercing.
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

        // Per-tool call-count cap. Independent of the per-user budget
        // — protects a SINGLE session from runaway loops on cost-
        // amplifying tools (image gen, web search, page render). On
        // hit, we return a TOOL ERROR (not abort) so the model can
        // wrap up its response gracefully without further tool use.
        // Counter is incremented only AFTER passing the cap check, so
        // a capped tool's "rejection" doesn't itself bump the count.
        const cap = SESSION_TOOL_CALL_CAPS[call.name]
        if (typeof cap === 'number') {
          const used = toolCallCounts.get(call.name) ?? 0
          if (used >= cap) {
            log(`[limits] tool call cap reached: ${call.name} (${used}/${cap})`)
            responseParts.push({
              functionResponse: {
                id: call.id,
                name: call.name,
                response: {
                  output: `Tool call limit reached for ${call.name} (${cap}). Wrap up your response.`,
                  isError: true
                }
              }
            })
            continue
          }
          toolCallCounts.set(call.name, used + 1)
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
              outcome = 'budget-exhausted'
              errorMessage = e.message
              emitBudgetBreadcrumb(e)
              return
            }
            if (e instanceof SessionCapExhausted) {
              outcome = 'session-cap-exceeded'
              errorMessage = e.message
              setStatus('error', e.message)
              return
            }
            throw e
          }
          try {
            const out = await webSearch(ai, model, query, abortController.signal)
            result = { content: out.text, isError: false }
            // Persist sources on the activity row so the drawer can
            // render a clickable list when the user expands. Cap at 10
            // — most queries return 5-15 chunks and 10 sources is the
            // reading-comfort ceiling for the narrow sidebar.
            void logAiTool(aiSession.docId, {
              kind: 'ai.tool',
              tool: 'web_search',
              query: query.slice(0, 200),
              sources: out.sources.slice(0, 10).map(s => ({
                title: s.title.slice(0, 200),
                uri: s.uri.slice(0, 500)
              }))
            })
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
              outcome = 'budget-exhausted'
              errorMessage = e.message
              emitBudgetBreadcrumb(e)
              return
            }
            if (e instanceof SessionCapExhausted) {
              outcome = 'session-cap-exceeded'
              errorMessage = e.message
              setStatus('error', e.message)
              return
            }
            throw e
          }
          try {
            const out = await fetchUrl(ai, model, url, abortController.signal)
            result = { content: out.text, isError: false }
            // Persist the resolved url + summary + image strip so the
            // drawer renders a real preview without a second fetch.
            void logAiTool(aiSession.docId, {
              kind: 'ai.tool',
              tool: 'fetch_url',
              url: out.url.slice(0, 500),
              summary: out.summary.slice(0, 600),
              images: out.images.slice(0, 6).map(i => ({
                url: i.url.slice(0, 500),
                description: i.description?.slice(0, 200)
              }))
            })
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
          // Surface meta-tools as ai.tool rows so the activity feed shows
          // every meaningful AI action — generate_image, plus the read-
          // only tools that don't bubble through Y.js (view_image,
          // search_knowledge, get_knowledge_file). Skipped: view_document
          // and read_comments (pure noise — AI reads doc state every turn).
          if (!result.isError) {
            if (call.name === 'generate_image') {
              const a = validatedArgs as { prompt?: string }
              const prompt = typeof a.prompt === 'string' ? a.prompt.slice(0, 300) : ''
              void logAiTool(aiSession.docId, { kind: 'ai.tool', tool: 'generate_image', prompt })
            } else if (call.name === 'view_image') {
              const a = validatedArgs as { src?: string }
              const src = typeof a.src === 'string' ? a.src.slice(0, 500) : ''
              void logAiTool(aiSession.docId, { kind: 'ai.tool', tool: 'view_image', src })
            } else if (call.name === 'search_knowledge') {
              const a = validatedArgs as { query?: string }
              const query = typeof a.query === 'string' ? a.query.slice(0, 200) : ''
              void logAiTool(aiSession.docId, { kind: 'ai.tool', tool: 'search_knowledge', query })
            } else if (call.name === 'get_knowledge_file') {
              const a = validatedArgs as { knowledge_id?: string }
              const knowledgeId = typeof a.knowledge_id === 'string' ? a.knowledge_id.slice(0, 64) : ''
              void logAiTool(aiSession.docId, { kind: 'ai.tool', tool: 'get_knowledge_file', knowledgeId })
            }
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
        outcome = 'success'
        setStatus('done', 'Done')
        return
      }

      contents.push({ role: 'user', parts: responseParts })
    }

    // Ran out of turns.
    outcome = 'turn-limit'
    errorMessage = `Hit turn limit (${MAX_TURNS})`
    setStatus('error', 'Hit turn limit')
  } catch (e) {
    // If the loop body already classified the throw (abort) leave the
    // outcome alone; otherwise let the default 'error' stand and stamp
    // the message so the telemetry event groups on it.
    if (outcome === 'error') {
      errorMessage = e instanceof Error ? e.message : String(e)
    }
    throw e
  } finally {
    // Single emission point. Wrap defensively so a Sentry transport
    // hiccup never propagates into the agentic loop's caller — failed
    // telemetry must be invisible to the user.
    try {
      const toolCounts: Record<string, number> = {}
      for (const [k, v] of telemetryToolCounts) toolCounts[k] = v

      Sentry.captureMessage('ai-session-completed', {
        level: 'info',
        tags: {
          component: 'ai-session',
          event: 'completed',
          outcome,
          docId: aiSession.docId,
          // String for tag-search compatibility — Sentry's tag filter
          // works on string equality, not numeric comparison.
          initiatorUserId: String(aiSession.initiatorUserId)
        },
        extra: {
          sessionId,
          turnCount,
          totalInteractions: interactionsThisSession,
          // -1 sentinel when the SDK never surfaced usageMetadata
          // — preserves "no data" vs "actually 0" distinction.
          totalInputTokens: sawAnyUsageMetadata ? totalInputTokens : -1,
          totalOutputTokens: sawAnyUsageMetadata ? totalOutputTokens : -1,
          totalThinkingTokens: sawAnyUsageMetadata ? totalThinkingTokens : -1,
          toolCallCounts: toolCounts,
          abortReason,
          errorMessage,
          durationMs: Date.now() - startedAt,
          plan: billingContext.plan,
          attributedTo: billingContext.attributedTo
        }
      })
    } catch (e) {
      // Don't log via the user-facing `log` helper — that prefix is
      // for prompt-loop chatter. console.warn keeps it visible while
      // making clear the error is from the telemetry path.
      console.warn(`[runLoop telemetry] capture failed: ${e instanceof Error ? e.message : e}`)
    }
  }
}
