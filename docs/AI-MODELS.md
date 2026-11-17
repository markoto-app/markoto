# AI models

Which models power markoto's AI features, why, and which models we recommend if you bring your own key. Last reviewed: 2026-11-03. All prices are public list prices in USD from the provider, and they change; check the provider before budgeting.

markoto routes every AI call through one gateway (LiteLLM), so each model below is a configuration choice, not a code dependency.

**Who provides which model.** Chat (the writing agent), image generation and voice transcription are **bring your own key** (see [Bring your own key](#bring-your-own-key)): each user connects their own OpenAI-compatible provider, or uses a default the instance operator configured. The hosted markoto SaaS configures one: a monthly [free AI allowance](#free-ai-allowance-hosted) for chat on Z.ai GLM-5.3 Flash served by Mistral in the EU; image generation and transcription stay bring-your-own-key there. Embeddings, web search (Staan) and page fetching (Jina Reader) are always provided by the platform (or, for embeddings on a self-hosted instance, by the operator, see [Embeddings](#embeddings)); they are never per-user.

## Bundled models (operator defaults)

These are the deployments that ship in `deploy/config/litellm/config.yaml`. A self-hoster can make them the instance defaults (`NUXT_AI_DEFAULT_CHAT_MODEL=mistral-small-2603`, `NUXT_AI_DEFAULT_IMAGE_MODEL=flux-3-image-klein`, `NUXT_AI_DEFAULT_TRANSCRIBE_MODEL=voxtral-mini-transcribe`); calls then run on the operator's Mistral / BFL keys and debit each user's AI Points budget. The platform-provided rows (embeddings, page extraction, web search) are always active. The data path of these bundled providers stays inside the EU: Mistral AI (Paris), Jina AI (Berlin), Staan (European Search Perspective SAS) and Black Forest Labs (EU-pinned endpoint).

**Mistral is EU-only.** Every Mistral deployment (chat, fallbacks, transcription) and the live-dictation WebSocket on the operator's key go to Mistral's EU regional endpoint `api.eu.mistral.ai` (inference in EU / EFTA data centres; the default `api.mistral.ai` makes no location commitment). Mistral bills regional inference at 1.1x list on every token type; the prices below are those EU prices (list in brackets), and they are what `deploy/config/litellm/config.yaml` charges to budgets. A user's own Mistral key runs on whichever Mistral host the user configured.

| Feature | Model | Price (EU endpoint) | Notes |
|---|---|---|---|
| AI writing assistant (tool calling, vision) | Mistral Small 4 (`mistral-small-2603`) | $0.165 in / $0.66 out per M tokens, cached input $0.0165 (list $0.15 / $0.60 / $0.015) | 262K context, function calling, vision; also the fallback of the free allowance |
| Fallback when the primary is rate-limited | Ministral 3 8B (`ministral-8b-2512`) | $0.165 in / $0.165 out per M tokens (list $0.15 / $0.15) | 262K context, function calling, vision |
| Worker model (hosted): delegated rewrites, scans, web-tool synthesis | Ministral 3 8B as alias `markoto-worker` | $0.165 in / $0.165 out per M tokens (list $0.15 / $0.15) | See [Worker model](#worker-model) |
| Strong worker (hosted, plans with `aiStrongModel`): translate, rewrite | Mistral Small 4 as alias `markoto-worker-strong` | $0.165 in / $0.66 out per M tokens, cached input $0.0165 | See [Worker model](#worker-model) |
| Free AI allowance (hosted chat default) | Z.ai GLM-5.3 Flash served by Mistral (`zai-glm-5-3-flash`) | $0.165 in / $0.55 out per M tokens, cached input $0.033 (list $0.15 / $0.50 / $0.03) | 1M context, function calling, vision, reasoning. See [Free AI allowance](#free-ai-allowance-hosted) |
| Voice prompt (one-shot transcription) | Voxtral Mini Transcribe 2 (`voxtral-mini-2602`) | $0.0033 per audio minute (list $0.003) | GA |
| Live dictation | Voxtral Mini Transcribe Realtime (`voxtral-mini-transcribe-realtime-2602`) | $0.0066 per audio minute (list $0.006) | GA, WebSocket streaming |
| Knowledge-base embeddings | Jina `jina-embeddings-v5-text-nano` | about $0.02-0.05 per M tokens (verify) | 768 dimensions, 8K context |
| Web page extraction | Jina Reader | billed in output tokens from a shared Jina balance, about $0.05 per M; charged to users as a flat $0.001 per fetch | See [Web search and page fetch](#web-search-and-page-fetch-charged-to-the-ai-budget) |
| Web search | Staan ("Web Search for AI") | EUR 4 per 1,000 requests; charged to users as $0.005 per search | See [Web search and page fetch](#web-search-and-page-fetch-charged-to-the-ai-budget) |
| Image generation | Black Forest Labs FLUX 3 Image Klein (`flux-3-image-klein`), EU endpoint | $0.009 per 1024x1024 image, $0.014 up to about 4 MP | BFL rewrites the prompt before generating |

## Review findings and decisions

### Chat / agent model: keep Mistral Small 4

Sources: [Mistral models overview](https://docs.mistral.ai/getting-started/models/models_overview/), [Mistral pricing](https://docs.mistral.ai/inference/pricing), [Mistral changelog](https://docs.mistral.ai/getting-started/changelog/).

- Mistral Small 4 (v26.03) is still the current Small model and is not deprecated. Its predecessors (3.0, 3.1, 3.2) have all been retired.
- Alternatives from the same provider: Mistral Medium 3.5 ($1.50 / $7.50 per M tokens, 10x the input and 12.5x the output price) and Mistral Large 4 (Public Preview since 2026-10-06, $1.36 / $4.18, 1M context, reasoning output).
- We ran the same six-case, nine-tool function-calling check at temperature 0 against Small 4, Medium 3.5, Ministral 3 8B, 14B and 3B. All five picked the right tool with valid JSON arguments in every case. The one "miss" was the same on every model, and it was reasonable behaviour (read the document before editing). That check is small and is not a benchmark, but it gives no evidence that the 8-12x more expensive models would improve tool selection for our workload.
- Decision: keep Small 4. Revisit Medium 3.5 only if real-world agent quality (not price) becomes the bottleneck.
- Mistral Large 4 behaves differently: `temperature: 0` is rejected unless `top_p` is 1 (error 3054 "top_p must be 1 when using greedy sampling"), and message content comes back as a list of thinking and text blocks instead of a string. Our agent loop would need changes before using it.

### Fallback model: Ministral 3 8B, pinned

The deployment uses the dated id `ministral-8b-2512`, not the moving alias `ministral-8b-latest`, so an alias change cannot change behaviour or billing. List price $0.15 / $0.15 per M tokens.

### One-shot transcription: pin Voxtral Mini Transcribe 2

- The deployment pins `voxtral-mini-2602` (Voxtral Mini Transcribe 2, GA, $0.003/min list), so a change to the `voxtral-mini-latest` alias cannot change behaviour or billing. Retired ids are not always refused: Mistral may silently serve the alias instead, which is another reason to pin.
- Newer: on 2026-10-20 Mistral released the Voxtral 3 family in Public Preview: Voxtral Mini Transcribe 3 ($0.0035/min), Voxtral Small Transcribe 3 ($0.004/min) and Voxtral Mini Transcribe Realtime 3 ($0.008/min, latency configurable from 80 ms to 2.4 s). All four ids answer on `/v1/audio/transcriptions` with the same response shape as Transcribe 2. On our one short English test clip all produced identical text, so there is no evidence of a quality gain for dictating prose, while the price is 17-33% higher and the models are 6 days old and in preview. Decision: stay on the GA Transcribe 2 models and re-evaluate once Voxtral 3 is GA.

### Live dictation: keep Voxtral Realtime (26-02)

Live dictation uses `voxtral-mini-transcribe-realtime-2602` through the Mistral SDK realtime client. Realtime 3 costs 33% more ($0.008 vs $0.006 per minute list), is in preview, and Mistral does not document a protocol change. Decision: keep. The billing tick (`voxtral-realtime-tick`) charges $0.0066 per 60 s, the EU price (1.1 x $0.006). If Realtime 3 is adopted later, update the tick price and verify the SDK accepts the new id.

### Embeddings: keep Jina v5 text nano

Source: [Jina embeddings](https://jina.ai/embeddings/). The v5 family is current. May 2026 added v5-omni models (multimodal: images, audio, video, PDF). `v5-omni-nano` is also 768-dimensional, but multimodal input is not used by markoto and switching models forces a re-embed of every stored chunk, so there is no reason to change. No deprecations are announced. The price in our config ($0.02 per M) could not be confirmed from Jina's own pages (third-party sources quote about $0.05 per M on paid top-ups), so treat spend estimates for embeddings as approximate.

### Page extraction and search: unchanged

Jina Reader and Staan are unchanged. We found no deprecation notices. Staan lists its prices on [staan.ai](https://staan.ai/#pricing): EUR 2 per 1,000 requests for "Web Search" and EUR 4 per 1,000 for "Web Search for AI" (checked 2026-11).

### Image generation: FLUX 3 Image Klein

Source: [BFL release notes](https://docs.bfl.ai/release-notes) and [integration guidelines](https://docs.bfl.ai/api_integration/integration_guidelines) (checked 2026-11-13). FLUX 3 Image Klein is the small model of BFL's current generation: $0.009 per image at the `1k` size, against $0.030 for FLUX.2 [pro] and $0.048 for the full FLUX 3 Image. For illustrations in a document the small model is enough, and an image now takes about 2% of a free user's monthly allowance.

Calls go to `api.eu.bfl.ai`, BFL's EU endpoint (routing limited to its EU clusters). The former host `api.eu2.bfl.ai` is no longer documented and answers 503. The job is polled on the numbered EU cluster BFL names (`api.eu<N>.bfl.ai`); the proxy refuses a polling URL on any other host. A queued job can take more than 40 seconds, so the deployment has a 120-second timeout.

## Web search and page fetch: charged to the AI budget

`web_search` (Staan) and `fetch_url` (Jina Reader) are provided by the platform, also for users who brought their own chat key. Each call has two halves:

- **Upstream call** (Staan search / Jina Reader): the app calls it with the operator's key. Right before, it charges the call to the caller's AI budget: one completion on a billing-only model (`web-search-tick` / `web-fetch-tick`, `WebToolTickProvider` in `deploy/config/litellm/custom_handlers.py`) with the caller's virtual key (`server/utils/ai/webToolCharge.ts`). It appears in LiteLLM spend under `feature:web-search` / `feature:web-fetch` and in AI Points like every other AI call.
- **Synthesis** (summarising the results, or answering `fetch_url`'s `question`): runs on the session's [worker model](#worker-model), tagged `feature:utility`. With a BYOK key the user pays their own provider for those tokens (their "Fast model" if set); with an instance default it debits the budget like any other chat call. With no chat provider the raw results are returned unsynthesised. `fetch_url` with `mode: "extract"` makes no synthesis call: it returns the page Markdown in pages of about 8,000 characters (`page` picks one); each page is a fetch of its own and is charged and counted like one.

**Prices** (`output_cost_per_token` of the tick deployments; each tick reports one token):

| Tool | Charged per call | AI Points | Why |
|---|---|---|---|
| `web_search` | $0.005 | 5 | Staan "Web Search for AI" lists EUR 4 per 1,000 requests, about $0.0047 per search; rounded up for exchange-rate moves |
| `fetch_url` | $0.001 | 1 | Jina Reader bills the tokens of the returned page (about $0.05 per M, no per-request minimum). The app caps a page at 8,000 tokens (`X-Token-Budget`), at most about $0.0004 per fetch; the flat price sits above that so a price change or an over-cap page stays covered |

**Who pays.** The tick runs on the virtual key the session already uses, so it lands where every other AI call of that user lands:

- free tier: the user's own allowance and, on the hosted SaaS, the shared [free-tier pool](#free-ai-allowance-hosted);
- Pro (billing on): the user's own AI Points;
- Team / Business member inside the workspace: the member's limit and the workspace's pooled budget;
- own key (BYOK) for chat: still charged, because Staan and Jina are paid by the operator, not by the user's provider.

**Used up.** The proxy refuses the tick before Staan / Jina are called, and the tool answers 402 with the same code and text as other AI calls: `ai/free-allowance-exhausted` (shared pool), `ai/budget-exhausted` (own AI Points), or the workspace's team-budget / member-limit text. In the editor the AI gets a tool error; on a platform-paid chat model the next turn is refused by the same budget and the session ends with the usual message. Over MCP the tool call fails with that error.

**Not charged when.** Any other failure of the tick (proxy unreachable, a LiteLLM config without the tick models) is logged and the call goes ahead, still bounded by the rate limit below. `NUXT_LITELLM_WEB_SEARCH_TICK_MODEL=` / `NUXT_LITELLM_WEB_FETCH_TICK_MODEL=` (empty) switch charging off; a self-hoster with a custom LiteLLM config should either copy the two tick deployments or set those empty.

Each user also keeps a rate limit shared by `web_search`, `fetch_url`, the in-editor AI and MCP: **30 calls per hour and 100 per day** by default. Tune with `NUXT_WEB_TOOLS_HOURLY_LIMIT` / `NUXT_WEB_TOOLS_DAILY_LIMIT` (`0` = unlimited). Over the limit the tool answers 429 `ai/web-tools-rate-limited` (checked before the charge, so a refused call costs nothing); the editor AI sees a tool error and carries on without web access. The counters live in Valkey and fail open if Valkey is down.

**Self-hosting:** set `STAAN_API_KEY` and/or `JINA_AI_API_KEY` to enable the tools. With a key missing, that tool is not offered to the AI, is not listed over MCP, and `GET /api/ai/availability` reports `webTools.search` / `webTools.fetch` as `false`. (`JINA_AI_API_KEY` is also what the default embeddings use; with `custom-embeddings` it can stay empty.)

The free-tier AI Points budget (`TIER_FREE_LITELLM_BUDGET_USD`) resets monthly with billing off: every virtual key carries LiteLLM's `budget_duration: '30d'`, so no Stripe event is needed.

## Worker model

The worker model does the bulk work the writing agent hands off: delegated per-section rewrites and translations, read-only scans, and the utility sub-calls (`fetch_url` page extraction, `web_search` synthesis). Calls are tagged `feature:delegate-rewrite` (rewrite jobs) or `feature:utility` (the web-tool sub-calls), so the admin AI-spend page splits them from the loop's own turns. Resolution (`resolveWorkerProviders` / `workerProviderFor` in `server/utils/aiProviders/resolve.ts`):

1. The chat provider is the user's own key: their optional **Fast model** (Settings → AI provider → Chat, a second model id on the same base URL and key; it has no URL or key of its own, so it passes the same URL policy as the chat model), else their chat model. A user's own key is never replaced by a platform-paid model; translations and rewrites use their chat model.
2. `NUXT_AI_DEFAULT_WORKER_MODEL` (+ optional `_BASE_URL` / `_API_KEY`, same meaning as for `NUXT_AI_DEFAULT_CHAT_*`).
3. The chat default.

On plans with `aiStrongModel`, translations and rewrites use `NUXT_AI_DEFAULT_WORKER_STRONG_MODEL` (default `markoto-worker-strong`) instead, but only while `NUXT_AI_DEFAULT_WORKER_MODEL` is a LiteLLM alias (an operator endpoint is used as is). Scans, summaries, comments and the utility sub-calls always use the fast worker.

| Deployment | Worker | Strong worker |
|---|---|---|
| Hosted | `markoto-worker` (Ministral 3 8B, EU endpoint) | `markoto-worker-strong` (Mistral Small 4, EU endpoint), plans with `aiStrongModel` only |
| Self-host, nothing set | the chat default | the chat default |
| BYOK | the user's Fast model, else their chat model | the user's chat model |

**Why Ministral 3 8B.** Its input price is the same as the chat models' ($0.165 per M tokens on the EU endpoint), and its output is 4x cheaper than Mistral Small 4 ($0.165 vs $0.66 per M). Worker calls are output-heavy (a rewrite returns about as many tokens as it reads), so that is where the saving is. It produces no reasoning tokens, and it runs on Mistral's EU endpoint like every platform-paid Mistral call. Translation and tone quality matter most for paying plans, so those modes get Mistral Small 4 there. The two aliases fall back to each other's pool on a rate limit (`router_settings.fallbacks`). Their prices are mirrored in `server/utils/litellm/workerPrices.ts` for the cost estimate shown before a delegated job (a unit test keeps the two equal).

## Free AI allowance (hosted)

Signed-in users of the hosted SaaS who have not added their own key get a small monthly AI allowance on a platform-paid model. Anonymous visitors get no AI (AI always requires login). As soon as a user adds their own chat key under Settings → AI provider, that key is used instead (resolution order unchanged: own key → instance default → unavailable).

| Setting | Hosted value | Variable |
|---|---|---|
| Chat default | `zai-glm-5-3-flash` (LiteLLM alias) | `NUXT_AI_DEFAULT_CHAT_MODEL` |
| Vision | on (the model reads images) | `NUXT_AI_DEFAULT_CHAT_VISION` |
| Per user per month | $0.50 = 500 AI Points | `TIER_FREE_LITELLM_BUDGET_USD` |
| All free users together per month | $500 | `NUXT_FREE_TIER_TOTAL_BUDGET_USD` (unset / `0` = no ceiling, the self-host default) |

A self-hosted instance has none of these by default (no chat default, no ceiling); it can set the same variables.

### The model: Z.ai GLM-5.3 Flash, served by Mistral

Verified on 2026-11-03 against Mistral's model page, its regional-inference docs and a live `GET /v1/models` on both endpoints:

- **API id** `zai-glm-5-3-flash` (no aliases). **GA**, no deprecation date. Listed as a third-party model "served without Mistral modifications" (MIT-licensed weights); Mistral serves it on its own platform, on "the same infrastructure, regional controls, and service commitments as Mistral models". So the Mistral contract and the account's no-training opt-out cover it like Mistral's own models (the opt-out is an account setting under Admin → Privacy; check it stays off).
- **EU**: the default `api.mistral.ai` endpoint makes no location commitment. `api.eu.mistral.ai` processes inference in EU / EFTA data centres and serves this model; it costs 1.1x list. The deployment is pinned to it (`api_base` in `deploy/config/litellm/config.yaml`), and the costs there are the EU prices: $0.165 / $0.033 cached / $0.55 per M tokens.
- **Capabilities** (from `/v1/models`): `completion_chat`, `function_calling`, `vision`, `reasoning`; 1,048,576-token context, 128K max output. Tool calling and image input verified through our LiteLLM (a tool call with valid JSON arguments; a colour named from a test image).
- **Reasoning switched off**: it is a reasoning model, and without a setting Mistral lets it think a lot (1.2-4.9K reasoning tokens on an edit turn, ~20 s). The `zai-glm-5-3-flash` deployment sets `reasoning_effort: low` as a LiteLLM deployment parameter, so every caller (agent loop, `@ai`, MCP, web-tool synthesis) gets it and the fallback deployment never does. Mistral accepts only `low` / `high` / `max` (`none` is a 400, a Z.ai-style `thinking: {type: disabled}` a 422); `low` gives 0 reasoning tokens on plain chat turns and on most tool turns, at most ~130 on an edit turn. Any thinking arrives as `reasoning_content` (never shown to users); `content` holds only the answer, so the loop needs no change.
- **Prompt caching** is automatic. `usage.prompt_tokens_details.cached_tokens` reports hits, and LiteLLM bills them at `cache_read_input_token_cost` (uncached x input + cached x cached + output x output, on the key and the team). Measured behaviour: hits come in ~1152-token blocks and only for a prefix the cache has seen at least twice, so in practice the reused part is the prefix every user shares (system prompt + tools, ~15K tokens). The growing history of one session is rarely reused. About a third of calls miss entirely (replica routing); `prompt_cache_key` makes no measurable difference.
- **Fallback**: on 429 / 5xx / timeout after the proxy's retry, LiteLLM routes the request to `mistral-small-2603` (Mistral Small 4, also on the EU endpoint), so a fallback never leaves the EU path.

### How the limits are enforced

Both limits are LiteLLM budgets; the app keeps no counters.

- **$0.50 per user**: the `max_budget` of the user's virtual key, reset monthly (`budget_duration: 30d`, which LiteLLM normalises to the 1st of the month, 00:00 UTC).
- **$500 in total**: every free-tier key belongs to one LiteLLM team, `markoto-free-tier`, with `max_budget = NUXT_FREE_TIER_TOTAL_BUDGET_USD` and the same `30d` reset. LiteLLM checks the key AND the team before each call, so any platform-paid call of a free user draws on the pool: the agent loop, web search and page fetch (the per-call charge and the synthesis), MCP, and (on instances with such defaults) image generation, transcription and dictation ticks. The team id is fixed, so no app-side storage is needed (`server/utils/litellm/freeTierTeam.ts`).
- **Not in the pool**: BYOK calls (the `byok/*` deployment is zero-cost and LiteLLM skips budget checks for zero-cost models: verified, a BYOK call on a key whose team is exhausted still goes through), paid tiers once billing is on (their keys carry no team), and what the platform pays outside LiteLLM: knowledge-base embeddings (capped by the knowledge file / byte limits). The Staan / Jina Reader half of the web tools is in the pool through its per-call charge.
- **Membership**: new keys are created in the team; plan changes move keys in and out (`updateUserKeyBudget`); existing keys are reconciled at boot and every 6 h by the `litellm-key-reconcile` sweeper (one `/key/list` read, an update only for keys whose team, budget or reset differ, under the sweep lock), which also brings old keys to a lowered `TIER_FREE_LITELLM_BUDGET_USD`. LiteLLM only moves an existing key into a team its user belongs to, so the user is added as a team member first.
- **When the pool is used up**: LiteLLM answers `Budget has been exceeded! Team=markoto-free-tier …` (HTTP 422). The app maps it to **402 `ai/free-allowance-exhausted`** (distinct from the per-user `ai/budget-exhausted`): the prompt endpoints refuse up front, the agent loop ends with the same message, and the prompt bar shows "This month's free AI allowance is used up. Add your own key in Settings → AI provider to keep going." with a link to `/settings/ai`. LiteLLM only refuses once spend is strictly above the budget and checks before the call, so concurrent in-flight calls can overshoot the ceiling by a few cents.

### Cost per request

Measured through the proxy with the app's real system prompt, tool list and message translation, on the Q3 report fixture (`tests/e2e/fixtures/content/q3-report/`, ~25K-token requests): a typical prompt is a 3-call loop (`view_document`, one edit, finish).

| | GLM-5.3 Flash (EU price) |
|---|---|
| Cache hit ratio (prompt tokens served from cache) | 48-51 % |
| Cost per prompt, measured | $0.006-0.011, mean about $0.008 |
| Same prompt without caching | about $0.013 |
| Prompts per user per month ($0.50) | about 60 |
| Prompts per month for the whole pool ($500) | about 60,000 |

The cost rows were measured with Mistral's default thinking; with `reasoning_effort: low` the output share drops further, so they are a slight overestimate. Input dominates (about 95 % of the cost with thinking off). Thinking off vs Mistral's default (default measured with `max`, which reasons like the default; same fixture, same session, 8 prompts each):

| | Default thinking | `reasoning_effort: low` |
|---|---|---|
| Output tokens of an edit turn | 1,800-4,900 | 24-330 |
| Latency of an edit turn | ~20 s | ~4.4 s |
| Whole prompt (3-call loop) | ~25 s | ~17 s |
| A plain chat answer | 1.2-2.5 s, 180-530 output tokens | 0.4-0.9 s, 10-60 output tokens |
| Output cost per prompt | ~$0.0021 | ~$0.0002 |

Tool-call arguments stayed valid JSON and the edits stayed grounded in the document's figures.

### Prompt-caching layout

`server/utils/agentic/promptAssembly.ts` orders every request from most to least stable: static system prompt, tool definitions (fixed order, deterministic JSON), document context, workspace context, and only then, in the first USER message, the conversation memory, editor state and prompt. Within a session the history only appends and tool-call arguments are replayed byte-for-byte as the model generated them. Keep the conversation memory out of the system message: Mistral Small 4's template places the tool definitions after the system message, so memory there makes a follow-up prompt cache 0 %; in the first user message it caches 99 % (measured through the proxy; whole two-prompt sessions: 85 % cache hits instead of 65 %). GLM-5.3 Flash renders tools first and is unaffected (48-51 % either way). `tests/unit/ai/promptCachePrefix.test.ts` pins the layout; the loop logs `usage: prompt=… cached=…` per call and Sentry's `ai-session-completed` carries `totalCachedInputTokens`.

## Bring your own key

### What users can configure

Under **Settings → AI provider** (`/settings/ai`) each signed-in user can connect their own **OpenAI-compatible** provider, separately for three capabilities:

| Capability | Used by | Required? | Without it |
|---|---|---|---|
| Chat (+ optional Fast model) | The writing agent (prompt bar, selection rewrite), `@ai` in comments; the Fast model (else the chat model) runs large delegated edits and web-search / page-fetch summaries | Yes, for any AI feature (unless the instance provides a default) | The prompt bar shows "Add your API key in Settings", `@ai` shows the same hint; web search / page fetch hand raw results back instead of a summary |
| Image | `generate_image` (the provider's OpenAI images API, `/images/generations`) | Optional | The agent is not offered the `generate_image` tool |
| Transcription | Voice prompt (`/audio/transcriptions`); live dictation if the provider is Mistral | Optional | The microphone buttons are hidden |

Resolution order for every request, per capability: **the user's own config → the instance default → unavailable.**

Live dictation streams audio to Mistral's Voxtral Realtime API over a WebSocket that LiteLLM cannot proxy. It is offered only when the transcription provider is Mistral (`https://api.mistral.ai/v1`, the user's key) or when the instance default is a platform alias and the operator set `MISTRAL_API_KEY` for the app.

When the user saves a provider, markoto checks the URL (see below) and **verifies** it through the same LiteLLM path as real calls:

- Chat: a small completion with one tool definition at temperature 0. A tool call back means OK. A plain-text answer is saved with a warning ("no tool support"), because the agent needs tool calling. A Fast model gets a plain completion of a few tokens on the same URL and key; if it fails, nothing is saved.
- Transcription: a 0.5-second silent WAV (a fraction of a cent on the user's account).
- Image: no image is generated (that would be a paid image per save). markoto lists the provider's models (`GET {base URL}/models`) with the key instead: a 401/403 fails, a model missing from a returned list is a warning.

The API key is stored encrypted at rest (AES-256-GCM, same scheme as the LiteLLM virtual-key tokens), is never returned to the browser (the UI shows the host and the last four characters), never logged, and not included in the GDPR data export. Settings and keys are deleted with the account.

### Setting up a provider

| Provider | Base URL | Chat models to try | Image | Transcription |
|---|---|---|---|---|
| Mistral AI | `https://api.mistral.ai/v1` | `mistral-small-2603` (tested), `ministral-14b-2512` | - | `voxtral-mini-2602` (also unlocks live dictation) |
| OpenAI | `https://api.openai.com/v1` | `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.5` | `gpt-image-1` | `gpt-4o-mini-transcribe`, `whisper-1` |
| OpenRouter | `https://openrouter.ai/api/v1` | see the table below | - | - |
| Groq | `https://api.groq.com/openai/v1` | check Groq's tool-calling models | - | `whisper-large-v3-turbo` |
| Together AI | `https://api.together.xyz/v1` | provider list | provider list | - |
| DeepInfra | `https://api.deepinfra.com/v1/openai` | provider list | - | provider list |
| Fireworks AI | `https://api.fireworks.ai/inference/v1` | provider list | - | - |
| Scaleway (EU) | `https://api.scaleway.ai/v1` | provider list | - | provider list |
| Ollama (self-hosted only) | `http://host.docker.internal:11434/v1` | a tool-capable local model | - | - |

The base URLs were checked against each provider's `/models` and `/chat/completions` routes on 2026-10-26. The settings page fills them in from a preset list. Model ids differ per provider; the verification step catches an unknown id.

**Ollama / vLLM on a self-hosted instance.** markoto's LiteLLM container must reach the server. With Ollama on the Docker host, use `http://host.docker.internal:11434/v1` (the self-host compose maps that name to the Docker host for the `app` and `litellm` services; in another setup add `extra_hosts: ["host.docker.internal:host-gateway"]` to both) and set `NUXT_AI_BYOK_ALLOW_PRIVATE_URLS=true`, otherwise private addresses are refused. Ollama ignores the API key, but the field is required: enter any placeholder. Pick a model whose tool calling works through your server's OpenAI endpoint (vLLM needs `--enable-auto-tool-choice` with the right parser).

### Operator settings

| Variable | Meaning |
|---|---|
| `NUXT_AI_DEFAULT_{CHAT,IMAGE,TRANSCRIBE}_MODEL` | Instance default per capability. Alone, it names a model alias from `deploy/config/litellm/config.yaml` (platform-paid, debits AI Points; image aliases use the chat-wrapped convention of the bundled `flux-3-image-klein`, transcription aliases that of `voxtral-mini-transcribe`). |
| `NUXT_AI_DEFAULT_{CHAT,IMAGE,TRANSCRIBE}_BASE_URL` + `_API_KEY` | Together with `_MODEL`: an OpenAI-compatible endpoint used exactly like a user key (zero-cost to AI Points). The operator may point at private networks without the opt-in below; loopback, link-local/metadata addresses and markoto's own service names are still refused. |
| `NUXT_AI_DEFAULT_CHAT_VISION` | `false` if the default chat model can't read images (default `true`). |
| `NUXT_AI_DEFAULT_WORKER_MODEL` (+ `_BASE_URL` / `_API_KEY`) | The [worker model](#worker-model), same semantics as the chat default. Empty (self-host default) = the chat default. |
| `NUXT_AI_DEFAULT_WORKER_STRONG_MODEL` | Strong worker alias for translations and rewrites on plans with `aiStrongModel` (default `markoto-worker-strong`); used only while the worker model is an alias. |
| `NUXT_AI_BYOK_ALLOWED_BASE_URLS` | Comma-separated allowlist of base URLs users may pick. Empty (self-hosted default) = any public https URL. The hosted SaaS uses the eight non-local providers in the table above; an instance with `NUXT_LEGAL_SURFACES_ENABLED=true` (the hosted shape) refuses to boot with an empty list, and an entry that is not an absolute http(s) URL is a boot error everywhere. |
| `NUXT_AI_BYOK_ALLOW_PRIVATE_URLS` | `true` lets users point at private-network endpoints (RFC 1918, CGNAT, IPv6 ULA) and use plain http for them. Default `false`. |
| `NUXT_AI_REALTIME_MODEL` | Voxtral Realtime model for live dictation (default `voxtral-mini-transcribe-realtime-2602`). |
| `NUXT_FREE_TIER_TOTAL_BUDGET_USD` | Monthly ceiling in USD on platform-paid AI for all free-tier users together (a LiteLLM team budget, see [Free AI allowance](#free-ai-allowance-hosted)). Empty / `0` = none (self-host default); hosted 500. |

The hosted SaaS sets `NUXT_AI_DEFAULT_CHAT_MODEL=zai-glm-5-3-flash` (the [free AI allowance](#free-ai-allowance-hosted)), the image (`flux-3-image-klein`), transcription (`voxtral-mini-transcribe`) and strong-chat (`mistral-small-2603`) aliases (locked for the free tier, so they need the user's own key there), the worker aliases `markoto-worker` / `markoto-worker-strong`, and the provider allowlist above.

### How BYOK calls flow

Every BYOK call still goes through LiteLLM: the app sends model `byok/<model id>` plus the user's `api_key` and `api_base` in the request body (LiteLLM "clientside credentials"). The `byok/*` deployment has zero cost in `model_info`, so these calls never debit the user's AI Points budget, while the call still authenticates with the user's LiteLLM virtual key (requests-per-minute limit and spend-log tags keep working). Verified on LiteLLM v1.106.4: without the zero-cost entry, LiteLLM would apply its own price table to known model ids (for example `gpt-4o`) and bill the virtual key.

**AI Points.** The points meter in the top bar only appears when something the user can do is platform-paid (an instance alias default). With only their own keys it is replaced by a "Your own AI provider" chip linking to the settings; when both are in play, it says that own-key calls don't use points. With the free AI allowance the meter shows the per-user allowance (500 points for $0.50) and, once the shared pool is used up, the "free AI allowance is used up" line with the settings link.

### SSRF protection

The LiteLLM proxy connects to whatever base URL it is given, so a user-supplied URL is a server-side request forgery risk. markoto checks it in `server/utils/aiProviders/urlPolicy.ts`, when the user saves it **and again on every request**:

1. Absolute `http(s)` URL, no credentials, no query or fragment.
2. Never one of markoto's service hostnames: every service name, container name and network alias in the compose files (`litellm`, `postgres`, `markoto-app`, `s3-init`, …), compose's default container names (`<project>-<service>-<n>`), `localhost` / `*.localhost` and cloud-metadata names. The host is lowercased and trailing dots are removed first (`litellm.` is the same name). `tests/unit/aiProviders/internalHostnames.test.ts` reads the compose files, so a new service that is missing from the list fails CI.
3. With an allowlist configured, the URL must be at or below an allowlisted base URL.
4. Every DNS answer is checked: loopback, link-local (including `169.254.169.254`), multicast, unspecified, documentation and reserved addresses are always refused; private addresses only with `NUXT_AI_BYOK_ALLOW_PRIVATE_URLS=true`. Addresses are parsed into bytes, so every spelling counts: IPv6 forms that carry an IPv4 address (IPv4-mapped incl. the hex form `::ffff:7f00:1`, IPv4-compatible, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`) are judged by that IPv4 address; Teredo is always refused; site-local `fec0::/10` and unique-local `fc00::/7` count as private (`server/utils/agentic/urlGuard.ts`, shared with the AI URL tools).
5. Plain http only with that opt-in and only to private addresses, so an API key never crosses the internet unencrypted.

LiteLLM v1.106.4 does **not** run its own `user_url_validation` DNS check on a clientside `api_base` when a deployment opts in with `configurable_clientside_auth_params` (we verified that a request to `169.254.169.254` was attempted). The app check is therefore the authoritative gate. The `byok/*` deployment additionally carries a regex that refuses literal loopback, metadata, IPv6-literal and markoto-service targets as defence in depth; it is the same for SaaS and self-host, because the deployment-specific parts (allowlist, private opt-in, DNS) can't be expressed in a static config file.

**Redirects are not followed.** LiteLLM's default OpenAI client follows HTTP redirects, so a provider host that passes the check could answer 302/307 and send the proxy to an internal address the check never saw (verified on v1.106.4 for chat, streaming chat, image generation and transcription; transcription even returned the target's body as the transcript). `deploy/config/litellm/custom_handlers.py` sets `litellm.client_session` / `litellm.aclient_session` to httpx clients with `follow_redirects=False`, which LiteLLM uses for every OpenAI-SDK-backed call. A redirect fails the call ("the provider answered with a redirect"); enter the provider's final API URL. Pinned by `tests/integration/endpoints/byokRedirect.test.ts`.

**Error messages carry no upstream text.** A failed BYOK call (and a failed verification) shows a fixed sentence per failure class (`PROVIDER_ERROR_MESSAGES` in `server/utils/aiProviders/requestFields.ts`); the key-redacted upstream detail goes to the server log only.

Residual risk: LiteLLM resolves the hostname again when it connects. A DNS answer that changes between markoto's check and LiteLLM's connection (rebinding with a near-zero TTL) is not caught. On the hosted SaaS the allowlist limits hostnames to the major providers, which closes this; self-hosters who allow free-form URLs accept it.

## AI by plan

The instance defaults (`NUXT_AI_DEFAULT_*`) are platform-paid, so a plan
decides which of them apply (`shared/config/tiers.ts`):

| Switch | Unlocks | Env (per plan) |
|---|---|---|
| `aiImage` | `NUXT_AI_DEFAULT_IMAGE_*` (image generation) | `TIER_<PLAN>_FEATURE_AI_IMAGE` |
| `aiVoice` | `NUXT_AI_DEFAULT_TRANSCRIBE_*` (voice prompt + live dictation) | `TIER_<PLAN>_FEATURE_AI_VOICE` |
| `aiStrongModel` | the user's "Strong" pick in Settings → AI provider → `NUXT_AI_DEFAULT_CHAT_STRONG_MODEL` instead of the chat default; delegated translations and rewrites on `NUXT_AI_DEFAULT_WORKER_STRONG_MODEL` | `TIER_<PLAN>_FEATURE_AI_STRONG_MODEL` |

- Chat on the platform default is in every plan. A user's own key always
  works, whatever the plan (BYOK never consumes platform budget).
- The plan that counts is the one that pays: inside a Team / Business
  workspace its plan (for members), else the user's own
  (`resolvePayingPlan` / `resolveBillingContext(...).plan`). Voice prompts
  send the open document's workspace; dictation reads it from the doc.
- A capability the platform offers but the plan lacks is reported as
  `locked: 'plan'` by `GET /api/ai/availability`; the UI shows the control
  locked (mic, dictation) with "upgrade" / "coming soon" / "ask your admin"
  and "add your own key". The API answers 409 `plan/feature-unavailable`.
- Committed defaults = self-host: every switch on. Hosted: image
  (`flux-3-image-klein`), voice (`voxtral-mini-transcribe`) and the strong model
  (`mistral-small-2603`) are configured, and the free tier has all three
  off (`infra/render-env.sh`), so with billing off nobody gets them on
  markoto.app without their own key.

## Recommended models for bring-your-own-key

markoto's agent exposes about 29 tools (document editing, theme, web, image, comments, knowledge search), so the model needs reliable multi-tool function calling at low temperature, ideally with vision. Context needs are modest (documents plus tool results, typically under 100K tokens).

Only the Mistral rows below were tested by us (six tool-selection prompts against nine tool definitions at `temperature: 0`). Everything else is based on provider listings and should be tried before you rely on it. Prices are approximate public list prices per million input / output tokens.

| Provider | Model | Tools | Vision | Context | Approx. price | Notes |
|---|---|---|---|---|---|---|
| Mistral | `mistral-small-2603` (Small 4) | Tested | Yes | 262K | $0.15 / $0.60 | The bundled default. Best value. |
| Mistral | `ministral-14b-2512` | Tested | Yes | 262K | $0.20 / $0.20 | Cheaper output, simpler answers |
| Mistral | `ministral-8b-2512` | Tested | Yes | 262K | $0.15 / $0.15 | Fallback tier |
| Mistral | `mistral-medium-3-5` | Tested | Yes | 262K | $1.50 / $7.50 | For harder writing/editing tasks |
| Mistral | `mistral-large-4` (preview) | Not usable at temperature 0 without `top_p: 1` | Yes | 1M | $1.36 / $4.18 | Returns reasoning blocks |
| OpenAI | GPT-5.5 | Listed | Yes | 1M | $5 / $30 | Per third-party pricing summary; verify |
| OpenAI | GPT-5.4 mini | Listed | Yes | not verified | $0.75 / $4.50 | Per third-party pricing summary; verify |
| OpenAI | GPT-5.4 nano | Listed | Yes | not verified | $0.20 / $1.25 | Per third-party pricing summary; verify |
| OpenRouter | `moonshotai/kimi-k3.1-pro` | Advertised for agent use | Yes | 1.05M | $2 / $10 | Not tested |
| OpenRouter | `minimax/minimax-m3.1-flash` | Advertised for agent use | Yes | 1.05M | $0.10 / $0.55 | Not tested |
| OpenRouter | `deepseek/deepseek-v4.1-flash-1017` | Advertised for agent use | Yes | 1.05M | $0.02 / $1 | Not tested |
| Local (Ollama / vLLM) | Mistral Small 4 (open weights, Apache 2.0) | Yes | Yes | 262K | free, needs a large GPU | Same behaviour as the hosted default |
| Local (Ollama / vLLM) | Ministral 3 14B / 8B (Apache 2.0) | Yes | Yes | 262K | free, fits a single consumer GPU | Quantised builds may weaken tool use |
| Local (Ollama / vLLM) | Qwen 3.6 family, GLM-5.1, Kimi K2.6 | Advertised | Varies | up to 262K | free, large GPU for the bigger ones | Not tested; check your server's tool-call parser |

Practical tips:

- Set temperature to 0 for the agent model. Some reasoning models reject it or require extra parameters.
- Local servers must expose an OpenAI-compatible `/v1/chat/completions` with tool calling enabled (for example vLLM's `--enable-auto-tool-choice` with the right parser). Without it the agent cannot call any tool.
- Models that return their reasoning as structured blocks instead of a plain string may need adapter support.
- Bring-your-own-key covers chat, image generation and transcription. Embeddings are not per-user: the platform provides them on the hosted service, and on a self-hosted instance the operator configures them (see [Embeddings](#embeddings)).

## Embeddings

Embeddings power the workspace knowledge base (uploaded files are chunked, embedded and searched with pgvector plus full-text search). They always go through the LiteLLM proxy.

- **Hosted markoto:** we provide the embeddings (Jina `jina-embeddings-v5-text-nano`, 768 dimensions), at no charge to users, and they cannot be changed by users. Nothing in this section applies to the hosted service.
- **Self-hosted:** the operator of the instance can choose any embedding model and its dimension with environment variables. Same code, only configuration differs. Embeddings are an operator-level setting, billed to whatever key you configure; they are unrelated to per-user bring-your-own-key for chat.

### Configuration

| Variable | Read by | Default | Meaning |
|---|---|---|---|
| `NUXT_LITELLM_EMBEDDINGS_MODEL` | app | `jina-embeddings-v5-text-nano` | LiteLLM model name the app asks for. Set to `custom-embeddings` to use your own provider. |
| `NUXT_LITELLM_EMBEDDINGS_DIMS` | app | `768` | Output size of the model. Integer, at most **2000**. |
| `EMBEDDINGS_UPSTREAM_MODEL` | LiteLLM | `openai/text-embedding-3-small` | Any LiteLLM model id: `openai/<name>` for OpenAI-compatible servers, `mistral/mistral-embed`, `ollama/nomic-embed-text`, ... Only used by `custom-embeddings`. |
| `EMBEDDINGS_UPSTREAM_API_BASE` | LiteLLM | `https://api.openai.com/v1` | Endpoint of the provider. |
| `EMBEDDINGS_UPSTREAM_API_KEY` | LiteLLM | empty | Provider key (empty for keyless local servers). |
| `NUXT_LITELLM_EMBEDDINGS_SEND_DIMENSIONS` | app | `auto` | `auto` / `true` / `false`. Whether to send the OpenAI `dimensions` parameter. `auto` = only for Jina models. |
| `NUXT_LITELLM_EMBEDDINGS_TASK_HINTS` | app | `auto` | `auto` / `true` / `false`. Whether to send Jina's `task` parameter. `auto` = only for Jina models. |

The three `EMBEDDINGS_UPSTREAM_*` variables are consumed by the LiteLLM container through `deploy/config/litellm/config.yaml` (`custom-embeddings` entry, `os.environ/...` references), so no Python or YAML needs editing. The compose files give them placeholder defaults because the proxy refuses to start if a referenced variable is undefined. The compose files also forward `EMBEDDINGS_UPSTREAM_MODEL` to the app, where it only labels the stored version tag (`custom/openai/text-embedding-3-small:1536`) so that a later model change is detectable.

`dimensions` is off by default for non-Jina models on purpose: most models reject it (LiteLLM answers 400 for OpenAI-compatible models other than `text-embedding-3-*`). Turn it on only to shrink a model that supports reduced sizes, for example `text-embedding-3-large` at 1536. If the model's native output size already equals `NUXT_LITELLM_EMBEDDINGS_DIMS`, leave it off. In every case the app checks that the returned vector has exactly `NUXT_LITELLM_EMBEDDINGS_DIMS` entries and fails with a message naming the variable if not.

The 2000 limit is pgvector's maximum for an HNSW index on a `vector` column. Models with larger native output (for example `text-embedding-3-large` at 3072) need a reduced size via `SEND_DIMENSIONS=true` or are not usable.

### Examples

All go in `.env` (then restart the stack).

OpenAI `text-embedding-3-small`, native 1536 dimensions:

```
NUXT_LITELLM_EMBEDDINGS_MODEL=custom-embeddings
NUXT_LITELLM_EMBEDDINGS_DIMS=1536
EMBEDDINGS_UPSTREAM_MODEL=openai/text-embedding-3-small
EMBEDDINGS_UPSTREAM_API_KEY=sk-...
```

OpenAI `text-embedding-3-large` reduced to 1536:

```
NUXT_LITELLM_EMBEDDINGS_MODEL=custom-embeddings
NUXT_LITELLM_EMBEDDINGS_DIMS=1536
NUXT_LITELLM_EMBEDDINGS_SEND_DIMENSIONS=true
EMBEDDINGS_UPSTREAM_MODEL=openai/text-embedding-3-large
EMBEDDINGS_UPSTREAM_API_KEY=sk-...
```

Mistral `mistral-embed`, 1024 dimensions:

```
NUXT_LITELLM_EMBEDDINGS_MODEL=custom-embeddings
NUXT_LITELLM_EMBEDDINGS_DIMS=1024
EMBEDDINGS_UPSTREAM_MODEL=mistral/mistral-embed
EMBEDDINGS_UPSTREAM_API_BASE=https://api.mistral.ai/v1
EMBEDDINGS_UPSTREAM_API_KEY=...
```

Local Ollama `nomic-embed-text`, 768 dimensions, Ollama running on the Docker host:

```
NUXT_LITELLM_EMBEDDINGS_MODEL=custom-embeddings
NUXT_LITELLM_EMBEDDINGS_DIMS=768
EMBEDDINGS_UPSTREAM_MODEL=ollama/nomic-embed-text
EMBEDDINGS_UPSTREAM_API_BASE=http://host.docker.internal:11434
```

The self-host compose maps `host.docker.internal` to the Docker host for the LiteLLM service; elsewhere add `extra_hosts: ["host.docker.internal:host-gateway"]` to it. Any other OpenAI-compatible server (vLLM, llama.cpp, LocalAI) works with `openai/<served-name>` and its `/v1` base URL.

Jina (the default): leave all of the above unset, or set `NUXT_LITELLM_EMBEDDINGS_MODEL=jina-embeddings-v5-text-nano` explicitly. `JINA_AI_API_KEY` is required either way, because `fetch_url` uses Jina Reader.

The verified path: LiteLLM v1.106.4 resolves `os.environ/...` for `model`, `api_base` and `api_key`, forwards `dimensions` for `text-embedding-3-*`, and does not send it when the app leaves it out.

### What happens when you change the model or dimension

At startup, after migrations, the app compares the dimension of the knowledge vector column (default `vector(768)`) with `NUXT_LITELLM_EMBEDDINGS_DIMS`, under a Postgres advisory lock so several instances cannot race:

- **Same size:** nothing happens.
- **No vectors stored yet** (fresh install, or nothing was uploaded): the column is retyped and the HNSW index recreated in one transaction. A fresh self-hosted install just sets the variables and starts.
- **Vectors of another size are stored:** the app refuses to touch them. Only the knowledge features are disabled (uploads fail with the reason, `search_knowledge` reports it); the editor, sync, auth and AI keep working. The reason is logged, sent to Sentry and shown as `checks.embeddings` in `/api/health/deep`. It does not change `/api/health` or the overall status, so the instance is not taken out of rotation. The check re-runs about every ten seconds, so no restart is needed after the re-embed below.

Changing to a different model with the **same** dimension (say 768 to a different 768-d model) is not detected as a mismatch, because the column type is identical. Run the re-embed command anyway: vectors from different models are not comparable and search quality would be wrong. Each file stores a version tag (`provider/model:dims`); a changed model changes the tag, so the command re-embeds every file. The one case the tag cannot see is two different `custom-embeddings` models without `EMBEDDINGS_UPSTREAM_MODEL` reaching the app (the compose files forward it; a bare `bun run dev` does not). Then pass `--force` once.

### Re-embedding

After editing `.env` to the new model (and restarting so the app picks it up), run the re-embed command. The app image ships it as a bundled CLI (`/app/cli/reembed-knowledge.js`), and the container already has every variable it needs (`POSTGRES_*`, `NUXT_LITELLM_URL`, `NUXT_LITELLM_MASTER_KEY`, `NUXT_LITELLM_EMBEDDINGS_*`):

```
docker compose exec app bun cli/reembed-knowledge.js --dry-run   # report what would change
docker compose exec app bun cli/reembed-knowledge.js
```

On the self-host stack, `./install.sh reembed --dry-run` / `./install.sh reembed` is the same thing. From a source checkout (development, or a machine that can reach Postgres and the LiteLLM proxy) the equivalent is `bun run knowledge:reembed -- --dry-run`, reading the repo-root `.env`.

It takes the same advisory lock as the boot reconciliation, drops the HNSW index, retypes the column if the dimension changed (discarding the old vectors), re-embeds every chunk from its stored text file by file, and recreates the index at the end. It is resumable: if it stops (provider rate limit, network), run it again and it continues with the files still stale. Options: `--batch-size` (chunks per request group, default 50), `--concurrency` (parallel requests, default 5), `--pause-ms` (pause between groups, to stay under rate limits), `--force` (re-embed even files whose tag already matches; pass it once, never when resuming), `--dry-run`.

Expect one embeddings request per chunk (a chunk is about 800 characters, roughly 200 tokens). A knowledge base of 10,000 chunks is about 2 million tokens, which costs a few cents with hosted models (OpenAI `text-embedding-3-small` is $0.02 per million tokens at the time of writing, check your provider) and takes roughly 10 to 30 minutes at 5 parallel requests. Local models are free but bounded by your hardware. While it runs, knowledge search is degraded: files that are not re-embedded yet have no vectors (or vectors from the old model), and the index is missing until the end. Do not run it while a user is relying on knowledge search; the editor itself is unaffected.

## Sources

- Mistral models overview: https://docs.mistral.ai/getting-started/models/models_overview/
- Mistral pricing: https://docs.mistral.ai/inference/pricing
- Mistral changelog: https://docs.mistral.ai/getting-started/changelog/
- Voxtral Mini Transcribe 3: https://docs.mistral.ai/models/voxtral-mini-transcribe-3-0
- Voxtral Mini Transcribe Realtime 3: https://docs.mistral.ai/models/voxtral-mini-transcribe-realtime-3-0
- Mistral `/v1/models` (queried live 2026-10-26 for ids, context, capabilities; again 2026-11-03 on `api.mistral.ai` and `api.eu.mistral.ai` for `zai-glm-5-3-flash`)
- Z.ai GLM-5.3 Flash on Mistral: https://docs.mistral.ai/models/zai-glm-5-3-flash
- Mistral regional inference (EU endpoint, 1.1x pricing): https://docs.mistral.ai/inference/regional-inference
- Mistral third-party open models announcement (2026-08-11): https://mistral.ai/news/regional-inference-open-models-new-compute/
- Mistral prompt caching: https://docs.mistral.ai/studio-api/conversations/advanced/prompt-caching
- Mistral training opt-out (API): https://help.mistral.ai/en/articles/347614-can-i-opt-out-of-my-input-or-output-data-being-used-for-training
- Jina embeddings: https://jina.ai/embeddings/
- Jina API pricing: https://jina.ai/api-dashboard/pricing
- BFL pricing docs: https://docs.bfl.ai/quick_start/pricing
- OpenRouter tool-calling listing: https://openrouter.ai/models?supported_parameters=tools&order=top-weekly
- Third-party OpenAI price summary: https://morphllm.com/openai-api-pricing
