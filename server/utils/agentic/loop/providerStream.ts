import {
  AgenticFinishReason as FinishReason,
  type AgenticContent as Content,
  type AgenticFunctionCall as FunctionCall,
  type AgenticFunctionDeclaration as FunctionDeclaration,
  type AgenticAIClient as AiClient
} from '../aiTypes'
import { litellmStream } from '../../litellm/createCompletion'
import { LitellmBudgetExhausted, isBudgetExceededError } from '../../litellm/userKeys'
import { FREE_ALLOWANCE_EXHAUSTED_MESSAGE, isFreeAllowanceExhaustedError } from '../../litellm/freeTierTeam'
import { MEMBER_LIMIT_REACHED_MESSAGE, TEAM_BUDGET_EXHAUSTED_MESSAGE, isWorkspaceTeamBudgetError } from '../../litellm/workspaceTeams'
import {
  internalToOpenAIMessages,
  internalToOpenAITools,
  openAIStreamToInternalChunks,
  type StreamChunk
} from '../messageTranslation'
import { useLitellmForUser } from '../../ai/litellmClient'
import { providerRequestFields, withProviderErrors, redactProviderStream } from '../../aiProviders/requestFields'
import type { ResolvedAiProvider } from '../../aiProviders/resolve'
import { FEATURE_TAGS, featureMetadata } from '../../litellm/featureTags'
import { budgetExhaustedBreadcrumb } from '../../billing/billingMode'
import { newStreamState, processChunk } from '../streamStatus'
import type { LoopContext, ResponseParts } from './loopContext'

// One model call per turn: open the stream (classifying budget refusals
// into a typed outcome) and consume it into the turn's parts, tool calls
// and finish reason.

/**
 * One line per LLM call with the prompt-cache hit, so cache regressions
 * show up in the server log (and the flow suites' output) per turn.
 */
function logTurnUsage(ctx: LoopContext, usage: StreamChunk['usageMetadata']): void {
  if (usage?.promptTokenCount === undefined) return
  const cached = usage.cachedContentTokenCount ?? 0
  ctx.log(`usage: prompt=${usage.promptTokenCount} cached=${cached} output=${usage.candidatesTokenCount ?? 0} reasoning=${usage.thoughtsTokenCount ?? 0}`)
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
export async function consumeStreamTurn(
  stream: AsyncIterable<StreamChunk>,
  ctx: LoopContext
): Promise<{ modelParts: ResponseParts, functionCalls: FunctionCall[], finishReason: FinishReason | undefined }> {
  const streamState = newStreamState()
  const modelParts: ResponseParts = []
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
    // Anything outside the enum is treated as `OTHER` (terminal).
    const reason = chunk.candidates?.[0]?.finishReason
    if (reason) {
      finishReason = (Object.values(FinishReason) as string[]).includes(reason)
        ? reason as FinishReason
        : FinishReason.OTHER
    }

    ctx.telemetry.noteUsage(chunk.usageMetadata)
    logTurnUsage(ctx, chunk.usageMetadata)
  }

  return { modelParts, functionCalls, finishReason }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * A budget refusal from LiteLLM ends the session with a typed outcome
 * instead of an error. Returns false for any other error (the caller
 * rethrows it).
 */
function handleBudgetRefusal(ctx: LoopContext, e: unknown): boolean {
  // The shared free-tier pool is used up (LiteLLM team budget, see
  // `litellm/freeTierTeam.ts`). Not the user's own allowance, so no
  // "AI Points exhausted" breadcrumb in the (possibly shared) document:
  // the session ends with the typed message, which reaches the
  // initiator only, and the prompt bar's credits refresh shows the
  // "add your own key" toast.
  // Team / Business workspace: the pooled team budget or the
  // member's own limit. Never "upgrade" and no breadcrumb in the shared
  // document — the message reaches the initiator only.
  if (ctx.opts.billingContext.attribution === 'workspace' && (isWorkspaceTeamBudgetError(e) || isBudgetExceededError(e))) {
    const team = isWorkspaceTeamBudgetError(e)
    ctx.telemetry.outcome = team ? 'team-budget-exhausted' : 'member-limit-reached'
    ctx.telemetry.errorMessage = errorText(e)
    ctx.opts.setStatus('error', team ? TEAM_BUDGET_EXHAUSTED_MESSAGE : MEMBER_LIMIT_REACHED_MESSAGE)
    return true
  }
  if (isFreeAllowanceExhaustedError(e)) {
    ctx.telemetry.outcome = 'free-allowance-exhausted'
    ctx.telemetry.errorMessage = errorText(e)
    ctx.opts.setStatus('error', FREE_ALLOWANCE_EXHAUSTED_MESSAGE)
    return true
  }
  if (e instanceof LitellmBudgetExhausted || isBudgetExceededError(e)) {
    ctx.telemetry.outcome = 'budget-exhausted'
    ctx.telemetry.errorMessage = errorText(e)
    emitBudgetBreadcrumb(ctx, ctx.opts.billingContext.plan)
    return true
  }
  return false
}

/** Open the LLM stream. Returns a tagged result so the caller can short-circuit on budget exhaustion without losing the throw vs typed-result distinction. */
export async function openProviderStream(ctx: LoopContext): Promise<{ kind: 'stream', stream: AsyncIterable<StreamChunk> } | { kind: 'budget-exhausted' }> {
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
    if (handleBudgetRefusal(ctx, e)) return { kind: 'budget-exhausted' }
    throw e
  }
}

// Streaming dispatcher. Without `opts.ai` the stream goes through
// `streamFromLiteLLM` (OpenAI SDK -> LiteLLM proxy). With an injected fake
// `AgenticAIClient` (tests) it yields scripted internal-shape chunks and skips
// the OpenAI-shape translation, which `messageTranslation.test.ts` pins
// separately.

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
    // Prompt caching (Mistral + the GLM models it serves) is AUTOMATIC on a
    // byte-identical request prefix: cached tokens bill at 10 % (Mistral
    // Small) / 20 % (GLM-5.3 Flash) of the input price. The prefix is set up
    // by `promptAssembly.ts` (static system prompt + tools first, per-prompt
    // context in the user message) and kept by this loop (history is
    // append-only; tool-call arguments replay byte-for-byte, see
    // `messageTranslation.ts`). Per-turn hits are logged (`usage: …`).
    //
    // `prompt_cache_key` groups every turn / prompt / user on a doc. Mistral
    // documents it as raising the chance of a hit when requests spread over
    // replicas (it guarantees nothing). LiteLLM's mistral provider does not
    // list it as supported, so `drop_params` would strip it; the deployments
    // in deploy/config/litellm/config.yaml opt in via `allowed_openai_params`, which
    // makes v1.106.4 forward it (verified in the proxy's request transform).
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
