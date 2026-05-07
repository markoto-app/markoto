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
import { LitellmBudgetExhausted, isBudgetExceededError } from '../litellmKeys'
import { executeFunctionByName } from '../aiToolAdapter'
// (executeFunctionByName already covers `message_to_user` in its
//  dispatcher — used by the no-tool-call salvage path below.)
import { ALL_TOOL_DECLARATIONS, TOOL_SCHEMAS, webSearch, fetchUrl } from './functionTools'
import { SESSION_INTERACTION_CAP, SESSION_TOOL_CALL_CAPS } from './limits'
import {
  internalToOpenAIMessages,
  internalToOpenAITools,
  openAIStreamToInternalChunks,
  type StreamChunk
} from './messageTranslation'
import { useLitellmForUser } from '../litellmClient'
import { FEATURE_TAGS, featureMetadata } from '../litellm/featureTags'
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
 * The agentic loop: call the LLM (Mistral via LiteLLM) with streaming +
 * function calling, dispatch any client-side tool invocations, loop
 * until the model emits a plain text response (no function calls) or
 * we hit a stop condition.
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
 * Distinct from `LitellmBudgetExhausted` (the per-user monthly $ cap
 * enforced by LiteLLM) so the billing breadcrumb path doesn't also
 * fire here.
 *
 * Phase 6 note: this is a runaway-loop SAFETY cap (orthogonal to cost).
 * It prevents pathological prompt-injection ping-pong where a single
 * session burns through 50+ tool calls. The per-user MONTHLY $ cap is
 * LiteLLM's job — it 4xx's the chat completion the moment the user's
 * `max_budget` is crossed.
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
   * disabled (cheapest + fastest). Mistral has no equivalent so this
   * is effectively a no-op on the production path; kept on the
   * options surface for the test seam (which still drives the historic
   * `AgenticAIClient` shape).
   */
  thinkingBudget?: number
  /**
   * Override the function declarations handed to the model. Defaults
   * to `ALL_TOOL_DECLARATIONS`. Callers that want additional tools
   * (e.g. knowledge-base access for workspace docs) pass
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
  /**
   * Optional callback fired ONCE per validated tool call (after Zod
   * validation, before per-tool cap checks). Used by the prompt
   * endpoint to record an `ai_session_messages` row so the next
   * prompt's `<conversation_history>` block reflects what this session
   * did. Fire-and-forget: the loop awaits the callback but swallows
   * errors so a memory hiccup never aborts an in-flight loop.
   *
   * `message_to_user` is recorded SEPARATELY by its handler (it has
   * the verbatim body the prompt block needs); other tools are
   * recorded here in compacted form via `summarizeToolCall`.
   */
  onToolCall?: (name: string, validatedArgs: unknown) => Promise<void>
  /**
   * When this session was triggered by an `@markoto` mention in a
   * comment thread, the thread id rides on opts so the salvage path
   * (model emits prose instead of a tool call) calls
   * `reply_to_comment` against this thread instead of the default
   * `message_to_user`. Without this, comment-trigger sessions where
   * Mistral picks free-text over a tool call (which it does — the
   * "MUST end with reply_to_comment" mandate, originally tuned
   * pre-Phase-5 for Gemini, doesn't reliably bind on Mistral) silently
   * land in the prompt-bar response panel rather than the comment
   * thread, and the thread looks ignored.
   */
  commentThreadId?: string | null
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
  // from cost-amplifying outliers (50+ tool calls, or N+ calls to
  // image gen / search / etc.). See `limits.ts` for the rationale on
  // each ceiling. `SessionCapExhausted` propagates out of `noteInteraction()`
  // so the existing turn-loop catch path treats it the same as a
  // mid-loop runaway: emit setStatus('error', …) and exit.
  //
  // Phase 6: the per-user monthly $ budget is LiteLLM's job — see
  // `LitellmBudgetExhausted` catches around the streaming call. The
  // session counter is purely about safety (preventing a single
  // pathological loop from bumping itself out of context).
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
  // cost the most?" without correlating LiteLLM spend logs by hand.
  const startedAt = Date.now()
  let turnCount = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalThinkingTokens = 0
  let sawAnyUsageMetadata = false
  let outcome: SessionOutcome = 'error'
  let abortReason: string | undefined
  let errorMessage: string | undefined

  // Phase 6: per-user $ budget enforcement is LiteLLM's job. App-side
  // we only track the session-level safety counter to abort runaway
  // loops (50+ interactions in one session = something went off-rails).
  // No DB writes from here; LiteLLM bills each underlying chat / image
  // / tick call automatically.
  const noteInteraction = (delta: number, reason: string): void => {
    if (interactionsThisSession + delta > SESSION_INTERACTION_CAP) {
      log(`[limits] session interaction cap reached (${interactionsThisSession}+${delta} > ${SESSION_INTERACTION_CAP}); aborting`)
      throw new SessionCapExhausted(
        `Session interaction cap reached (${SESSION_INTERACTION_CAP}). The agentic loop ran too long; please try a more focused prompt.`
      )
    }
    interactionsThisSession += delta
    log(`[runLoop] noted +${delta} (${reason}; session=${interactionsThisSession})`)
  }
  log(`[billing] session resolved: ${billingContext.attributedTo} plan=${billingContext.plan} virtualKey=…${billingContext.virtualKey.slice(-6)}`)

  /**
   * Graceful mid-loop exhaustion handler. Writes an upgrade breadcrumb
   * into the Y.Doc via the same transaction origin the other tools
   * use, so it participates in undo/redo + the normal awareness flow.
   * Returning vs throwing: we RETURN so the outer try/finally in
   * prompt.post runs cleanup, tears down the AI session, and logs
   * "aborted" rather than an unhandled error.
   *
   * Phase 6: triggered by LiteLLM's HTTP 400 `budget_exceeded` (or our
   * `LitellmBudgetExhausted` wrapper) — the per-user $ cap.
   */
  const emitBudgetBreadcrumb = (plan: string): void => {
    const msg = `\n\n_AI Points exhausted for this billing period (plan: ${plan}). [Upgrade your plan](/pricing) to continue._\n`
    try {
      aiSession.ydoc.transact(() => {
        aiSession.ytext.insert(aiSession.ytext.length, msg)
      }, `ai:assistant:${sessionId}`)
    } catch (e) {
      log(`failed to write budget-exhausted breadcrumb: ${e instanceof Error ? e.message : e}`)
    }
    setStatus('done', 'AI Points exhausted')
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
      log(`turn ${turns}: calling LLM (${contents.length} messages)`)
      // Per-session safety check (no DB write — Phase 6 retired the
      // app-side counter). LiteLLM enforces the per-user $ budget
      // natively on the chat-completion call below.
      try {
        noteInteraction(1, `turn ${turns}`)
      } catch (e) {
        if (e instanceof SessionCapExhausted) {
          outcome = 'session-cap-exceeded'
          errorMessage = e.message
          setStatus('error', e.message)
          return
        }
        throw e
      }

      let stream: AsyncIterable<StreamChunk>
      try {
        stream = await streamFromProvider({
          ai,
          model,
          contents,
          systemPrompt,
          toolDeclarations,
          abortSignal: abortController.signal,
          thinkingBudget,
          virtualKey: billingContext.virtualKey,
          workspaceId: aiSession.workspaceId ?? null,
          initiatorUserId: aiSession.initiatorUserId ?? null,
          docId: aiSession.docId ?? null
        })
      } catch (e) {
        // LiteLLM 4xx with `budget_exceeded` → emit upgrade breadcrumb,
        // bail cleanly. Distinct from a generic upstream error so the
        // user sees a useful explanation rather than a stack trace.
        if (e instanceof LitellmBudgetExhausted || isBudgetExceededError(e)) {
          outcome = 'budget-exhausted'
          errorMessage = e instanceof Error ? e.message : String(e)
          emitBudgetBreadcrumb(billingContext.plan)
          return
        }
        throw e
      }

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
        // if the turn continues. The provider splits one logical response
        // across multiple chunks; each chunk contributes parts for the
        // same candidate.
        const parts = chunk.candidates?.[0]?.content?.parts
        if (parts) modelParts.push(...parts)

        const calls = chunk.functionCalls
        if (calls?.length) functionCalls.push(...calls)

        // `finishReason` is typed `AgenticFinishReason | string` on the
        // chunk so the LiteLLM stream wrapper can pass through unmapped
        // OpenAI values (e.g. provider-specific extensions). At the
        // loop's bookkeeping site we only care about the recognised
        // enum values; anything else is treated as `OTHER` so the
        // existing exit-path code recognises it as terminal.
        const reason = chunk.candidates?.[0]?.finishReason
        if (reason) {
          finishReason = (Object.values(FinishReason) as string[]).includes(reason)
            ? reason as FinishReason
            : FinishReason.OTHER
        }

        // Token usage rolls up in `usageMetadata` on the final chunk. The
        // SDK exposes promptTokenCount / candidatesTokenCount /
        // thoughtsTokenCount as optional ints (undefined when the model
        // doesn't surface them — historically older models). We sum
        // across turns and surface -1 in the final telemetry payload
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
      // The model's continuation contract requires the model's Content block
      // to be present before the corresponding functionResponse user block.
      contents.push({ role: 'model', parts: modelParts })

      // No function calls → the model emitted pure prose. The system
      // prompt forbids this (every turn MUST end with a tool call) but
      // models drift — informational questions like "what is markoto?"
      // are the typical triggers, and Mistral in particular picks
      // free-text over a tool call more often than the historic
      // Gemini path did.
      //
      // Without a salvage path the user sees NOTHING: the model's text
      // is on the server side only, never reaches the document or the
      // response panel.
      //
      // Fork by session shape:
      //   - Comment-trigger session (`commentThreadId` set) → synthesise
      //     a `reply_to_comment(comment_id, body)` call so the prose
      //     lands as a reply on the right thread.
      //   - Otherwise (prompt-bar / selection-popup) → synthesise
      //     `message_to_user(is_question=false)`.
      //
      // The 600-char schema cap applies to both fallbacks; longer
      // prose truncates with an ellipsis. Memory recording happens
      // inside the respective handlers, so this stays in lockstep
      // with explicit calls.
      if (functionCalls.length === 0) {
        const proseText = modelParts
          .map((p) => {
            const text = (p as { text?: unknown }).text
            return typeof text === 'string' ? text : ''
          })
          .join('')
          .trim()

        if (proseText.length > 0) {
          const SCHEMA_MAX = 600
          const message = proseText.length > SCHEMA_MAX
            ? proseText.slice(0, SCHEMA_MAX - 1) + '…'
            : proseText
          const isCommentTrigger = typeof opts.commentThreadId === 'string' && opts.commentThreadId.length > 0
          const fallbackTool = isCommentTrigger ? 'reply_to_comment' : 'message_to_user'
          const fallbackArgs: Record<string, unknown> = isCommentTrigger
            ? { comment_id: opts.commentThreadId, body: message }
            : { message, is_question: false }
          log(`turn ${turns}: salvaging pure-prose response (${proseText.length} chars) via ${fallbackTool} fallback`)
          try {
            await executeFunctionByName(aiSession, fallbackTool, fallbackArgs)
          } catch (e) {
            log(`${fallbackTool} fallback failed: ${e instanceof Error ? e.message : e}`)
          }
        }

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
      // parts are the functionResponse entries (the model's continuation contract).
      const responseParts: NonNullable<Content['parts']> = []
      // For comment-trigger sessions the system prompt mandates ending
      // with `reply_to_comment`. Mistral occasionally honours that AND
      // then keeps emitting tool calls anyway (e.g. a follow-up
      // `replace_text` editing the doc). Treat a successful
      // `reply_to_comment` against THIS thread as a hard terminator —
      // otherwise the rainbow-ring "AI is responding…" indicator stays
      // up while the model burns turns on bogus tool calls until it
      // hits SESSION_INTERACTION_CAP or MAX_TURNS, and the comment
      // thread looks stuck server-side.
      const isCommentTriggerTurn = typeof opts.commentThreadId === 'string' && opts.commentThreadId.length > 0
      let repliedToTriggerComment = false
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

        // Validate args with the Zod schema registered for this tool. The
        // model *usually* returns args that match the declared schema,
        // but not guaranteed — surface schema failures cleanly to the
        // model so it can retry with the correct shape rather than
        // silently coercing.
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

        // Memory event — record the validated call (compacted) before
        // we run it. Fire-and-forget; errors swallowed so a memory
        // hiccup can't abort the loop. We record BEFORE the cap check
        // so the memory reflects what the model attempted, even if the
        // cap rejected this particular invocation. `message_to_user`
        // is special-cased upstream by the handler so it lands as a
        // verbatim row, not a compacted tool_call row — so we skip it
        // here to avoid a duplicate.
        if (opts.onToolCall && call.name !== 'message_to_user') {
          try {
            await opts.onToolCall(call.name, validatedArgs)
          } catch (e) {
            log(`onToolCall callback failed: ${e instanceof Error ? e.message : e}`)
          }
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
          // Per-session safety bookkeeping (no DB write). LiteLLM
          // bills the underlying Mistral synthesis call automatically
          // via the user's virtual key on the 2-call pattern.
          try {
            noteInteraction(4, `web_search sub-call`)
          } catch (e) {
            if (e instanceof SessionCapExhausted) {
              outcome = 'session-cap-exceeded'
              errorMessage = e.message
              setStatus('error', e.message)
              return
            }
            throw e
          }
          try {
            const out = await webSearch(ai, model, query, abortController.signal, {
              workspaceId: aiSession.workspaceId ?? null,
              userId: aiSession.initiatorUserId ?? null,
              docId: aiSession.docId ?? null
            })
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
        // that runs structured-output extraction in isolation from our
        // `functionDeclarations`.
          const { url } = validatedArgs as { url: string }
          try {
            noteInteraction(4, `fetch_url sub-call`)
          } catch (e) {
            if (e instanceof SessionCapExhausted) {
              outcome = 'session-cap-exceeded'
              errorMessage = e.message
              setStatus('error', e.message)
              return
            }
            throw e
          }
          try {
            const out = await fetchUrl(ai, model, url, abortController.signal, {
              workspaceId: aiSession.workspaceId ?? null,
              userId: aiSession.initiatorUserId ?? null,
              docId: aiSession.docId ?? null
            })
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
            // The internal continuation contract expects a Record here
            // (pre-migration: Gemini's SDK shape). We wrap into
            // `{ output, ... }` so the model sees a consistent shape;
            // include isError so it can react (e.g. try a different
            // old_str if replace_text failed).
            response: { output: result.content, isError: result.isError }
          }
        })
        // Tools that return non-JSON payloads (view_image → inlineData) smuggle
        // them out as sibling parts on the same user message. Must come AFTER
        // the functionResponse so the model links them to the right call.
        if (result.extraParts?.length) responseParts.push(...result.extraParts)

        // Comment-trigger terminator: if this call was a successful
        // reply_to_comment against the trigger thread, mark for break
        // after this turn's responseParts are flushed.
        if (
          isCommentTriggerTurn
          && call.name === 'reply_to_comment'
          && !result.isError
        ) {
          const a = validatedArgs as { comment_id?: unknown }
          if (typeof a.comment_id === 'string' && a.comment_id === opts.commentThreadId) {
            repliedToTriggerComment = true
          }
        }
      }

      if (repliedToTriggerComment) {
        log(`turn ${turns}: reply_to_comment landed on trigger thread — terminating comment-trigger loop`)
        outcome = 'success'
        setStatus('done', 'Done')
        return
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
//       chunks. This skips the OpenAI-shape translation in
//       `messageTranslation.ts` — that translation is pinned
//       independently by `messageTranslation.test.ts`, so unit tests
//       drive the loop's chunk-handling / tool-dispatch / finish-reason
//       logic without rebuilding OpenAI streaming fixtures for every
//       test.

interface StreamFromProviderOpts {
  ai?: AiClient
  model: string
  contents: Content[]
  systemPrompt: string
  toolDeclarations: FunctionDeclaration[]
  abortSignal: AbortSignal
  thinkingBudget: number
  /** Per-user LiteLLM virtual-key bearer token. */
  virtualKey: string
  /** Workspace context for spend-tagging. Null when the doc isn't in a workspace. */
  workspaceId?: string | null
  /** User who initiated the agentic loop — drives the user-axis spend tag. */
  initiatorUserId?: number | null
  /** Document the loop is attached to — drives the doc-axis spend tag. */
  docId?: string | null
}

async function streamFromProvider(
  opts: StreamFromProviderOpts
): Promise<AsyncIterable<StreamChunk>> {
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

async function streamFromLiteLLM(
  opts: StreamFromProviderOpts
): Promise<AsyncIterable<StreamChunk>> {
  // useRuntimeConfig is auto-imported in the Nitro runtime; defensively
  // gate so unit tests that don't run inside Nitro don't trip on the
  // missing global.
  const config = (typeof useRuntimeConfig === 'function' ? useRuntimeConfig() : {}) as { litellm?: { textModel?: string } }
  // Phase 6: per-user virtual-key auth. The LiteLLM proxy debits the
  // user's $ budget on every chat completion, and 4xx's with
  // `budget_exceeded` when crossed.
  const litellm = useLitellmForUser(opts.virtualKey)
  // The text model id is a separate config knob from the embeddings /
  // image / transcribe models; defaults to mistral-small-2603 (Phase 4
  // pick — see nuxt.config.ts comments + spike findings §22).
  const textModel = config.litellm?.textModel || 'mistral-small-2603'

  const messages = internalToOpenAIMessages(opts.systemPrompt, opts.contents)
  const tools = internalToOpenAITools(opts.toolDeclarations)

  // `stream_options.include_usage: true` makes Mistral emit token usage
  // on the final chunk so our existing `usageMetadata` accumulator
  // catches it.
  const oaiStream = await litellmStream(litellm, {
    model: textModel,
    messages,
    tools: tools.length > 0 ? tools : undefined,
    tool_choice: tools.length > 0 ? 'auto' : undefined,
    stream: true,
    stream_options: { include_usage: true },
    // Temperature 0 — the agentic loop is a deterministic-tool-
    // selection process (read the doc, pick the right tool, edit,
    // wrap up). Default sampling (~0.7 on Mistral) made tool choice
    // vary run-to-run: the SAME prompt sometimes triggered
    // `web_search`, sometimes `fetch_url`, sometimes a plain
    // `message_to_user` with no doc edit. This thrashed flow tests
    // (ai-web-search, ai-fetch-url, ai-cross-doc, etc.) and made
    // production behaviour feel "moody" — the user expects "summarise
    // the page" to consistently fetch + summarise, not occasionally
    // refuse without explanation. Synthesis sub-calls
    // (web_search → Mistral, fetch_url → Mistral) already run at 0;
    // pinning the outer loop matches that.
    temperature: 0,
    // LiteLLM spend-tags. Three axes: feature, workspace (when the
    // doc is in one), and the initiating user. Sub-tool synthesis
    // calls (web_search/fetch_url) inside this loop carry the same
    // tag set so the workspace breakdown stays consistent.
    ...featureMetadata(FEATURE_TAGS.textLoop, {
      workspaceId: opts.workspaceId,
      userId: opts.initiatorUserId,
      docId: opts.docId
    })
  }, { signal: opts.abortSignal })

  return openAIStreamToInternalChunks(oaiStream)
}
