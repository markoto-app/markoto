import { z } from 'zod'
import type { AgenticAIClient as AiClient } from '../../agentic/aiTypes'
import { litellmCompletion } from '../../litellm/createCompletion'
import { consumeWebToolQuota, isWebToolAvailable } from '../webTools'
import { chargeWebToolCall, type WebToolChargeContext } from '../webToolCharge'
import { useLitellmAdmin, useLitellmForUser } from '../litellmClient'
import { FEATURE_TAGS, featureMetadata } from '../../litellm/featureTags'
import { providerRequestFields, withProviderErrors } from '../../aiProviders/requestFields'
import type { ResolvedAiProvider } from '../../aiProviders/resolve'
import { useEnv } from '~~/shared/env/load'

/**
 * Context threaded into the web-tool charge and synthesis sub-calls.
 *
 * `workspaceId` / `userId` / `docId` drive the four-axis spend TAGS
 * (`featureMetadata` reads them). `virtualKey` is the LiteLLM per-user
 * virtual key the per-call charge (`chargeWebToolCall`) and the
 * synthesis call authenticate WITH, so the call lands on the caller's
 * `max_budget` and a budget-exhausted user's `web_search` / `fetch_url`
 * is refused before Staan / Jina are called. Both production call sites pass it
 * (the in-app loop from `billingContext.virtualKey`, MCP from
 * `MetaToolContext.virtualKey`); the admin-key fallback exists only so a
 * key-less harness path doesn't crash.
 */
export interface WebToolSpendContext extends WebToolChargeContext {
  /**
   * The session's chat provider (BYOK key or instance default). Read for
   * the refusal wording, and as the synthesis model when `workerProvider`
   * is not given.
   */
  chatProvider?: ResolvedAiProvider | null
  /**
   * The session's fast worker model (`workerProviderFor(providers, 'utility')`).
   * The synthesis step runs on it; when it and `chatProvider` are null (no
   * provider configured) the tools return the raw search results / page
   * text unsynthesised.
   */
  workerProvider?: ResolvedAiProvider | null
}

/** The model a web tool's synthesis runs on: the worker, else the chat provider, else none. */
export function synthesisProvider(ctx: WebToolSpendContext): ResolvedAiProvider | null {
  return ctx.workerProvider !== undefined ? ctx.workerProvider : (ctx.chatProvider ?? null)
}

export interface WebSearchResult {
  /** The synthesised answer text the main loop hands back to the model. */
  text: string
  /** Deduplicated grounding sources (title + uri). Used by the activity
   *  drawer to render a clickable list when the user expands the row. */
  sources: Array<{ title: string, uri: string }>
}

/**
 * Web-search sub-call: Staan returns ranked results, then the worker model synthesises
 * a cited answer. The outer loop emits the per-call status ("Searching the
 * web for ...") from the validated args before this runs, and we control the
 * output format (answer + bulleted sources).
 */
export async function webSearch(
  _ai: AiClient | undefined,
  _model: string,
  query: string,
  signal: AbortSignal,
  spendCtx: WebToolSpendContext = {}
): Promise<WebSearchResult> {
  // Abort guard: if we're already past the deadline, don't even issue the call.
  if (signal.aborted) throw new Error('aborted')
  if (!isWebToolAvailable('web_search')) throw new Error('Web search is not configured on this instance.')
  // Platform-paid upstream call: count it against the user's allowance
  // (shared with fetch_url and with MCP) before spending anything, then
  // charge it to the AI budget (refused when that is used up).
  await consumeWebToolQuota(spendCtx.userId)
  await chargeWebToolCall('web_search', spendCtx, signal)
  // Web search runs on Staan (staan.ai), a European search index (OVHcloud,
  // EU) with its own index rather than a Google/Bing fan-out through US
  // processors. EU-only routing (disabling Staan's optional US
  // fallback) is an ACCOUNT-LEVEL setting in the Staan dashboard, there is no
  // per-request parameter: so it must be verified enabled on the account.
  return await webSearchViaStaan(query, signal, spendCtx)
}

// AI grounding providers:
//
//   web_search → Staan /search/web (staan.ai): the European search index
//                returns ranked results (title/url/snippet) → worker-model
//                synthesis compresses them into a cited answer.
//   fetch_url  → Jina Reader (r.jina.ai) → worker-model synthesis with
//                json_schema strict:true extracting {summary, images[]}.
//                Jina stays for the direct-URL-fetch case: the user (or the
//                model) supplies a specific URL, so there is no Google/Bing
//                search backend involved: the EU-sovereignty concern that
//                motivated the Staan swap applies only to search fan-out.
//
// Staan's synthesising /answer endpoint would collapse this to one call but
// is gated to a higher plan tier (403 on the current key), so we keep our own
// synthesis step.

const _WEB_SEARCH_SYSTEM_PROMPT
  = 'You are a web-search synthesiser. Given a dump of search results '
    + 'as raw markdown, produce a single concise factual answer (3-6 '
    + 'sentences). Cite sources inline using [n] markers that index into '
    + 'the source list. Do not editorialise. Do not invent facts that '
    + 'aren\'t in the dump. If the dump doesn\'t answer the query, say '
    + 'so in one sentence.'

// Staan /search/web response envelope (fields we consume). See
// https://docs.staan.ai/docs/web-search.md.
// Third-party answers: a mistyped field reads as absent, a mistyped result is dropped.
const optionalText = z.string().optional().catch(undefined)
const staanSearchResponse = z.object({
  web: z.object({
    results: z.array(z.object({ title: optionalText, url: optionalText, snippet: optionalText }).nullable().catch(null)).catch([])
  }).optional().catch(undefined)
})

async function webSearchViaStaan(
  query: string,
  signal: AbortSignal,
  spendCtx: WebToolSpendContext = {}
): Promise<WebSearchResult> {
  const staanKey = useEnv().providers.staanApiKey
  if (!staanKey) {
    throw new Error('STAAN_API_KEY not configured (required for web_search)')
  }

  // 1) Staan search: returns up to 10 ranked results with title/url/snippet.
  //    Staan enforces a 400-char query cap and rejects longer queries.
  const staanRes = await fetch('https://api.staan.ai/v2/search/web', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${staanKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      q: query.trim().slice(0, 400),
      // en-us is the broadest index for an English-first product; the doc
      // language isn't threaded into this sub-call today. `count` is fixed
      // at 10 by the API.
      market: 'en-us'
    }),
    signal
  })
  if (!staanRes.ok) {
    throw new Error(`Staan search returned ${staanRes.status}`)
  }
  const staanPayload = staanSearchResponse.catch({}).parse(await staanRes.json())
  const results = (staanPayload.web?.results ?? []).flatMap(r => (r ? [r] : []))

  if (results.length === 0) {
    return {
      text: 'No search results returned. The query may be too specific or filtered.',
      sources: []
    }
  }

  // 2) Worker-model synthesis: pass results as a numbered list, ask for a
  //    concise answer with [n] citations.
  const dump = results.slice(0, 8).map((r, i) =>
    `[${i + 1}] ${r.title ?? ''}\nURL: ${r.url ?? ''}\n${(r.snippet ?? '').slice(0, 1500)}`
  ).join('\n\n---\n\n')

  const sources = results.slice(0, 8).map(r => ({
    title: (r.title ?? r.url ?? '').slice(0, 200),
    uri: r.url ?? ''
  })).filter(s => s.uri)

  // No chat provider (no BYOK key, no instance default): hand the raw
  // ranked results back instead of a synthesised answer. Search itself is
  // platform-provided and works without a key.
  const provider = synthesisProvider(spendCtx)
  if (!provider) {
    return { text: `Search results for "${query}":\n\n${dump}`, sources }
  }

  // Authenticate the synthesis with the caller's virtual key (rpm limits
  // + spend tags) and run it on the session's worker model, the user's
  // own key (and their fast model, if set) under BYOK. Fall back to the master key only when a key-less
  // harness path reaches here.
  const litellm = spendCtx.virtualKey ? useLitellmForUser(spendCtx.virtualKey) : useLitellmAdmin()
  const providerFields = await providerRequestFields(provider)

  const synth = await withProviderErrors(provider, () => litellmCompletion(litellm, {
    ...providerFields,
    messages: [
      { role: 'system', content: _WEB_SEARCH_SYSTEM_PROMPT },
      { role: 'user', content: `Query: ${query}\n\nSearch results:\n${dump}` }
    ],
    max_tokens: 400,
    // Modest temperature for the prose synthesis (no structured-output
    // contract). `fetch_url` synthesis stays at 0 because it has a strict
    // JSON schema; the outer agentic loop stays at 0 for tool determinism.
    temperature: 0.3,
    // Worker-model utility call: its own feature tag so /admin/ai-spend
    // splits it from the loop's turns; same workspace + user + doc axes.
    ...featureMetadata(FEATURE_TAGS.utility, spendCtx)
  }, { signal }))

  const answer = (synth.choices?.[0]?.message?.content ?? '').trim()

  if (!answer) {
    return { text: 'No answer returned by the synthesiser.', sources }
  }
  if (sources.length === 0) return { text: answer, sources: [] }
  const sourceList = sources.map(s => `  - ${s.title}: ${s.uri}`).join('\n')
  return { text: `${answer}\n\nSources:\n${sourceList}`, sources }
}
