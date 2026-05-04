# Gemini → Mistral + Jina + BFL behind LiteLLM — Migration Plan

> **Status**: planning, not implemented. Ready to hand to senior engineer.
> **Branch**: `claude/gemini-to-mistral-migration-6hmuU`
> **Author trail**: research + decisions captured during a planning session, May 2026.
> **Estimated effort**: ~9–12 engineer-days end-to-end (see §16).

---

## TL;DR

We migrate every LLM-adjacent capability off Google (`@google/genai`, `@google-cloud/speech`) and onto a three-vendor stack — **Mistral** (text + vision + STT), **Jina** (embeddings + reranker + Reader/Search), **Black Forest Labs** (image generation) — all routed through a self-hosted **LiteLLM Proxy** for cost tracking, virtual-key budgets, and provider-swap optionality. Live dictation WebSocket stays direct to Voxtral Realtime but is metered via a LiteLLM pass-through "tick" route so all spend lands in one ledger.

User-facing model: each subscription tier converts to a monthly LiteLLM budget (e.g. €20/mo plan → $10 budget → 1000 credits at $0.01/credit displayed). Free dictation minutes/day cap stays as a separate ceiling (defense-in-depth; LiteLLM is the cost oracle, not the only gate).

---

## 1. Why we're doing this

| Driver | Detail |
|---|---|
| **Vendor diversification** | Single-provider risk on AI (especially with billing-critical paths). Today everything routes through Google. |
| **EU-resident stack** | Mistral (Paris) + Jina (Berlin) + BFL (Freiburg) gives a fully-EU provider chain. Strategic re-export and data-residency optionality. |
| **Cost-tracking unification** | Today: `ai_usage_period` table + atomic counter in `runLoop.ts` + per-feature rate limits + Stripe-tied billing — split across 4–5 layers. After: one LiteLLM budget per virtual key, fetched on every UI render. |
| **Provider-swap optionality** | Today swapping vendors is a multi-day PR across `runLoop.ts`, `aiToolAdapter.ts`, `functionTools.ts`, `embeddings.ts`, env validation, secret rotation. After: a config-file change in LiteLLM. |
| **STT cost reduction** | Cloud STT v1 at $0.016/min → Voxtral at $0.001–0.003/min — **5–16× cheaper**, comparable or better quality (~4% WER on FLEURS). |
| **Image-edit feature surface** | Going BFL-direct unlocks `flux-kontext-pro` ($0.04/image) for in-place image editing — capability we don't have today. |

**What this is NOT:**
- A pure cost-cutting exercise. Per-text-turn Mistral pricing is comparable to Gemini Flash-Lite, with a small regression on prompt-caching (Gemini auto-caches, Mistral doesn't). The financial wins concentrate in STT and image gen, not text.
- A quality upgrade. Mistral Medium 3 is roughly Flash-Lite peer; Large 3 is moderately better. Don't oversell quality to stakeholders.

---

## 2. Current Gemini surface area (what we're replacing)

10 files, two SDKs (`@google/genai`, `@google-cloud/speech`).

| # | Feature | File:line | Current Google surface |
|---|---|---|---|
| 1 | Agentic text loop | `server/utils/agentic/runLoop.ts:269-282` | `generateContentStream` + `functionDeclarations` + `thinkingConfig` |
| 2 | Prompt entry point | `server/api/ai/prompt.post.ts:443-451` | `new GoogleGenAI({ apiKey })` |
| 3 | Comment trigger | `server/api/docs/[docId]/comments/[commentId]/trigger-ai.post.ts:269-274` | Same agentic loop, banned tools |
| 4 | 21 tool schemas | `server/utils/agentic/functionTools.ts:562` | `z.toJSONSchema(schema, { target: 'draft-7' })` → `functionDeclarations` |
| 5 | **Web search grounding** | `functionTools.ts:728-797` | `tools: [{ googleSearch: {} }]` |
| 6 | **URL context + structured output** | `functionTools.ts:844-886` | `tools: [{ urlContext: {} }]` + `responseSchema` |
| 7 | Image generation | `server/utils/aiToolAdapter.ts` | `gemini-3.1-flash-image-preview` + `responseModalities: ['IMAGE','TEXT']` |
| 8 | Embeddings ingest + query | `server/utils/embeddings.ts`, `server/utils/processKnowledge.ts` | `gemini-embedding-2-preview`, **768-d via MRL**, RETRIEVAL_DOCUMENT / RETRIEVAL_QUERY |
| 9 | Batch STT (voice prompt button) | `server/api/ai/transcribe.post.ts:138-195` | Cloud STT v1 REST, `latest_long`, hit by `app/composables/useVoicePrompt.ts:342` |
| 10 | Live dictation WS | `server/routes/api/ai/dictate.ts:439-490` | `@google-cloud/speech` v1 streaming, JWT-in-first-frame |
| 11 | STT mock for tests | `server/utils/agentic/dictateSpeechClient.ts` | `MockSpeechClient` triggered by `NUXT_GOOGLE_SPEECH_MOCK=1` |
| 12 | Config layer | `nuxt.config.ts:88-129` | `runtimeConfig.google.*` (10 env vars) |
| 13 | Secret validator | `server/plugins/01-validate-secrets.ts` | Fail-fast on missing `NUXT_GOOGLE_*` |

Gemini-specific features in use that need explicit handling:

| Gemini feature | Mistral equivalent |
|---|---|
| `generateContentStream` + tools | `chat/completions` with `stream: true` + `tools` (OpenAI-shape) |
| `systemInstruction` | `messages: [{ role: 'system', ... }]` |
| `thinkingConfig.thinkingBudget` | Not exposed identically; reasoning is via `magistral-*` family or Medium 3.5 |
| `responseSchema + responseMimeType: 'application/json'` | `response_format: { type: 'json_schema', json_schema: {...} }` |
| `tools: [{ googleSearch: {} }]` | **No equivalent on chat-completions.** Replaced by Jina `s.jina.ai`. |
| `tools: [{ urlContext: {} }]` | **No equivalent on chat-completions.** Replaced by Jina `r.jina.ai`. |
| `responseModalities: ['IMAGE', 'TEXT']` | Replaced by direct BFL FLUX call. |
| `inlineData: { mimeType, data }` (vision in) | Same shape on Pixtral / Mistral Medium 3.5. |
| `chunk.usageMetadata.{prompt,candidates,thoughts}TokenCount` | LiteLLM's response includes usage; no per-call code change needed. |
| Implicit prefix caching (auto, 75–90% off cached input) | **No equivalent.** Accepted regression — see §13. |

---

## 3. Target stack

| Capability | Provider | Model / endpoint | Routing |
|---|---|---|---|
| Text agentic loop | Mistral | `mistral/mistral-medium-3` (default), `mistral/mistral-large-3` (when reasoning needed), `mistral/mistral-medium-3.5` (vision-heavy turns) | LiteLLM native |
| Vision input (inline images) | Mistral | `mistral/pixtral-large-latest` or `mistral/mistral-medium-3.5` | LiteLLM native |
| Embeddings (ingest + query) | Jina | `jina_ai/jina-embeddings-v4` truncated to **768-d via MRL** (keeps existing pgvector schema) | LiteLLM native |
| Reranking (NEW capability) | Jina | `jina_ai/jina-reranker-v3` | LiteLLM native (`/rerank`) |
| Web search (replaces `googleSearch`) | Jina | `s.jina.ai` | LiteLLM **pass-through** with cost-per-request |
| URL read (replaces `urlContext`) | Jina | `r.jina.ai` | LiteLLM **pass-through** with cost-per-request |
| Batch STT (voice prompt button) | Mistral | `mistral/voxtral-mini-transcribe-v2` | LiteLLM native (`/transcription`) |
| Live dictation (WebSocket) | Mistral | Voxtral Realtime | **Direct WS** (LiteLLM is HTTP-only); metered via pass-through tick (§7) |
| Image generation | BFL | `black_forest_labs/flux-2-pro` (default, $0.03/img), `flux-1-kontext-pro` (editing, $0.04/img) | LiteLLM native |

LiteLLM Proxy itself is **self-hosted** (open-source Python/FastAPI), runs as a new container in `docker-compose.base.yml`. Backed by our existing managed Postgres (separate schema or new DB on the same instance — see §11.2).

---

## 4. The LiteLLM gateway

### 4.1 Architecture

```
                                 ┌────────────────┐
   prompt bar  ───────HTTP─────► │                │ ──HTTP──► Mistral text
   batch transcribe ─HTTP─────►  │   LiteLLM      │ ──HTTP──► Voxtral batch
   image gen   ───────HTTP─────► │   Proxy        │ ──HTTP──► BFL FLUX
   embeddings  ───────HTTP─────► │ (cost +        │ ──HTTP──► Jina /embed /rerank
   reranker    ───────HTTP─────► │  budget gate)  │
   web search  ─pass-through───► │                │ ──HTTP──► s.jina.ai
   url read    ─pass-through───► │                │ ──HTTP──► r.jina.ai
   voice tick  ─pass-through───► │                │ ──noop──► (just bills)
                                 └────────────────┘
                                        ▲
                                        │ /key/info readback
                                        │  for budget UI
                                        │
   live dictation ──direct WS──► Voxtral Realtime
        ▲                              │
        └──────── tick orchestrator ───┘
                  (60s pings to LiteLLM)
```

Every dollar of AI spend lands in LiteLLM. The only carve-out is the dictation WS payload itself (LiteLLM doesn't proxy WebSockets), and even that is metered through pass-through `/voice-tick` pings.

### 4.2 Virtual-key model

One LiteLLM virtual key per user. Created on first AI use (or at signup — TBD with product). Stored on `users` table as `users.litellm_key_id` (new column).

Workspace billing attribution:
- When a workspace member uses AI in a workspace with `workspaces.ai_enabled = true`, the request is sent with the **workspace owner's virtual key** in the `Authorization` header instead of the calling user's key. The decision lives in our app (`server/utils/billing.ts`), not LiteLLM.
- LiteLLM doesn't need to know about workspaces.

### 4.3 Credit math

| Plan | LiteLLM monthly budget | Displayed credits | Credit-to-dollar |
|---|---|---|---|
| Free | $0.10 | 10 | $0.01/credit |
| Pro ($20/mo) | $10 | 1000 | $0.01/credit |
| Team ($X/mo) | TBD | TBD | $0.01/credit |

Why $0.01/credit and 50% margin:
- Typical text turn on Mistral Medium 3 (6k input + 800 output): ~$0.0040.
- A grounded turn (text + Jina search + 1× Jina read): ~$0.012.
- An image-gen turn (text + BFL FLUX.2 [pro]): ~$0.034.
- Average across mix: ~$0.005/turn, peaks at ~$0.04/turn for image-heavy.
- 1000 credits = $10 budget = 250–2500 turns/month depending on mix. Generous for normal use, healthy margin for outliers.

### 4.4 Budget reset semantics

LiteLLM virtual keys can have a `duration` (e.g. `"30d"`) that auto-resets the budget. **Don't use this** — it doesn't align with Stripe's per-customer billing anchors. Instead:
- LiteLLM keys are created with `duration: null` (no auto-reset).
- The Stripe webhook (`server/utils/stripeWebhook.ts`) handler for `invoice.paid` resets the budget via `POST /key/update { max_budget: 10.0 }` on each successful renewal.
- Plan upgrades (`customer.subscription.updated`) update `max_budget` immediately to the new tier.
- Plan lapses (`invoice.payment_failed` after grace period) drop `max_budget` to free-tier value, not 0 — preserves UX of "limited but usable".

### 4.5 Authorization header propagation

Per request from our backend to LiteLLM:
```
Authorization: Bearer <user-or-workspace-virtual-key>
X-Litellm-Tags: feature=prompt,doc_id=<id>     (for spend categorization)
```

The user's session cookie auths them to our backend; our backend then translates to LiteLLM's virtual key. The virtual key never leaves our server.

---

## 5. Per-feature migration plan

### 5.1 Text agentic loop (`runLoop.ts`)

**Replace:**
```ts
const ai = new GoogleGenAI({ apiKey: config.google.geminiApiKey });
const stream = await ai.models.generateContentStream({
  model, contents, config: { systemInstruction, tools, thinkingConfig, ... }
});
```

**With (OpenAI SDK pointing at LiteLLM):**
```ts
const openai = new OpenAI({
  apiKey: userVirtualKey,
  baseURL: config.litellm.url + '/v1',
});
const stream = await openai.chat.completions.create({
  model: 'mistral-medium-3',
  messages: [{ role: 'system', content: systemPrompt }, ...history],
  tools: toolDeclarations,
  tool_choice: 'auto',
  stream: true,
  response_format: undefined,  // not used here
  user: userId,                 // for LiteLLM logging
});
```

Tool-call shape: Mistral's streamed `delta.tool_calls` is OpenAI-shaped — fragments accumulate into a complete JSON object on stream close. Existing parser in `runLoop.ts` needs adjustment but the structure is similar.

**Files touched:** `runLoop.ts`, `prompt.post.ts:443-451`, `trigger-ai.post.ts:269-274`.

**Re-tune required:** system prompt. Mistral models follow instructions slightly differently — expect a 1–2 day prompt-engineering pass to recover on the agentic eval suite.

### 5.2 Tool schemas (`functionTools.ts`)

The Zod-driven design (`z.toJSONSchema(schema, { target: 'draft-7' })`) is provider-agnostic. **No changes to schema definitions** for the 21 base tools.

**Tools that need a body rewrite:**
- `web_search` (lines 728–797) → swap inner `ai.models.generateContent({ tools: [{ googleSearch }] })` for a single `fetch(litellmUrl + '/jina_pass_through/s.jina.ai/?q=' + encodeURIComponent(query))`. The Jina response is markdown text + sources — concatenate and return.
- `fetch_url` (lines 844–886) → swap `ai.models.generateContent({ tools: [{ urlContext }] })` for `fetch(litellmUrl + '/jina_pass_through/r.jina.ai/' + encodeURIComponent(url))`. Then if the original `responseSchema` extraction was needed, run a follow-up `chat/completions` with `response_format: { type: 'json_schema' }` against the Reader's markdown output.

### 5.3 Vision input (`view_image`, `view_pages`)

Mistral's vision input shape:
```ts
messages: [{
  role: 'user',
  content: [
    { type: 'text', text: '...' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } },
  ],
}]
```

**Drop-in for current Gemini `inlineData` pattern.** Existing `aiToolAdapter.ts` builders need a small refactor of the message-construction helper.

### 5.4 Embeddings (`embeddings.ts`, `processKnowledge.ts`)

**Critical decision:** use **jina-embeddings-v4 with `truncate_dim: 768`** to **keep the existing `vector(768)` pgvector schema and HNSW index**.

LiteLLM call:
```ts
const res = await openai.embeddings.create({
  model: 'jina_ai/jina-embeddings-v4',
  input: chunkText,
  dimensions: 768,                    // MRL truncation
  // task_type: not exposed via LiteLLM yet — see §12 open questions
});
```

**Re-embed step** (one-time): after deploying the new code path, run a one-shot script that re-embeds every row in `workspace_knowledge_chunks`. Schema unchanged. See §11.1 for full plan.

**Hybrid search (`server/repos/knowledge.ts`)**: pgvector + tsvector + RRF stays as-is. Add a third stage:
```ts
const reranked = await openai.post('/rerank', {
  model: 'jina_ai/jina-reranker-v3',
  query: userQuery,
  documents: rrfTop20.map(r => r.content),
  top_n: 5,
});
```

Returns re-scored ordering; replace the final 5 results we feed to the agentic loop.

### 5.5 Image generation (`aiToolAdapter.ts:generateImageBytes`)

**Current:** Gemini call with `responseModalities`.
**New:** LiteLLM image-generation route to BFL.

```ts
const img = await openai.images.generate({
  model: 'black_forest_labs/flux-2-pro',
  prompt,
  size: '1024x1024',
  // BFL accepts megapixel-based pricing; LiteLLM exposes the standard params
});
// img.data[0].b64_json → existing S3 upload + DB row + markdown ref pipeline unchanged
```

Default model: **FLUX.2 [pro] at $0.03/image**. Add a config switch (`NUXT_LITELLM_IMAGE_MODEL`) so we can drop to `flux-2-klein-4b` ($0.014/image) for budget tier or `flux-2-max` for premium.

**New tool surface (out of scope for this migration but worth noting):** `flux-1-kontext-pro` for image editing ($0.04/image). Add a future `edit_image` tool — separate PR.

### 5.6 Batch STT — voice prompt button (`transcribe.post.ts`)

Currently used by `app/composables/useVoicePrompt.ts:342`. **Confirmed in active use** — not dead code.

**Replace** the Cloud STT REST call with LiteLLM's `/audio/transcriptions`:
```ts
const transcript = await openai.audio.transcriptions.create({
  file: audioBlob,
  model: 'mistral/voxtral-mini-transcribe-v2',
  language: bcp47LanguageHint,
});
```

LiteLLM bills `transcript.usage.duration_minutes * cost_per_minute` against the user's virtual key automatically.

### 5.7 Live dictation WS (`dictate.ts`)

**Replace** `@google-cloud/speech` streaming with Mistral's Voxtral Realtime SDK (or raw WS to `wss://api.mistral.ai/v1/realtime`).

The session lifecycle, JWT-in-first-frame auth, single-session Valkey lock, and idle-timeout logic all stay identical — only the inner streaming wrapper changes.

**Cost metering:** see §7 for the pass-through tick pattern.

**Mock for tests:** preserve the `NUXT_GOOGLE_SPEECH_MOCK=1` mock pattern but rename to `NUXT_VOXTRAL_MOCK=1`. Rewrite `dictateSpeechClient.ts:MockSpeechClient` to emit Voxtral-shaped frames.

### 5.8 Comment-trigger AI (`trigger-ai.post.ts`)

Same agentic loop machinery as `prompt.post.ts`. After §5.1 lands, this file is a near-mechanical port.

---

## 6. Cost analysis

### 6.1 Per-turn unit economics

Same 6k-input + 800-output text turn used in §7 of AGENTS.md:

| Path | Per turn | vs Gemini Flash-Lite |
|---|---|---|
| Gemini 3.1 Flash-Lite (current baseline) | $0.0027 | — |
| Mistral Small 3.2 ($0.075 / $0.20) | $0.00061 | **−77%** (quality risk on 21-tool loops) |
| **Mistral Medium 3 ($0.40 / $2.00)** ← chosen default | **$0.0040** | **+48%** |
| Mistral Large 3 ($0.50 / $1.50) | $0.0042 | +55%, materially higher quality |
| Mistral Medium 3.5 ($1.50 / $7.50) | $0.015 | +455%, vision-heavy turns only |

### 6.2 Per-feature comparison

| Feature | Gemini today | Target | Δ |
|---|---|---|---|
| Text turn (typical) | $0.0027 | $0.0040 (Medium 3) | +48% |
| Image generation | $0.045 (0.5K) | $0.030 (FLUX.2 [pro]) | **−33%** |
| Batch STT (per minute) | $0.016 | $0.001–0.003 (Voxtral Mini Transcribe V2) | **−81% to −94%** |
| Live STT (per minute) | $0.016 | ~$0.003 (Voxtral Realtime) | **−81%** |
| Embeddings (per M tokens) | "free during preview" | $0.02/M (Jina v3) or commercial-TBD (v4) | rough wash + migration |
| Web search (per call) | $0.014 above 5k/mo free | ~$0.006 (s.jina.ai) | **−57%** |
| URL read (per call) | bundled in `urlContext` | $0.005 (r.jina.ai) | new line, modest |
| Reranking (per call) | not used today | $0.02/M tokens | new line, capability upgrade |
| Image editing | not used today | $0.04 (FLUX.1 Kontext [pro]) | new capability |

### 6.3 Blended monthly envelope

Modeled on a §7-style typical user (200 turns/mo + 30 grounded turns + 5 image gens + 60 voice minutes batch + 30 voice minutes live):

```
text loop:        200 × $0.0040 = $0.80
grounded turns:    30 × $0.012  = $0.36   (Medium 3 + 1× Jina search + 1× Jina read)
image gen:          5 × $0.030  = $0.15
batch STT:         60 × $0.003  = $0.18
live STT:          30 × $0.003  = $0.09
─────────────────────────────────────
                                  $1.58/user/month
```

Comfortably inside a $10 LiteLLM budget. 84% margin for the Pro tier. Free tier ($0.10) is ~7 typical turns — intentional.

### 6.4 At-cap economics

A user pegged at the budget cap costs us $10/mo in AI spend on a $20/mo subscription. Since the Pro tier also covers everything else (sync, hosting, storage, S3 egress, Stripe fees), $10 is roughly the AI-budget envelope §7 already plans for. **No subscription-tier adjustment needed.**

---

## 7. Live voice metering — the pass-through tick pattern

### 7.1 Why this exists

LiteLLM is HTTP-only. Voxtral Realtime is a WebSocket. We can't proxy the WS through LiteLLM, but we want voice spend to land in the same per-user budget as everything else.

### 7.2 The mechanism

LiteLLM's pass-through endpoint feature supports a flat **cost-per-request**. We register a no-op pass-through route whose only job is to be called periodically as a billing pulse.

LiteLLM config:
```yaml
general_settings:
  pass_through_endpoints:
    - path: "/voice-tick"
      target: "https://app:3000/internal/litellm-noop"   # internal endpoint, returns 200 OK
      cost_per_request: 0.003                              # = 1 minute of Voxtral Realtime
      forward_headers: false
      auth: true                                           # require virtual key
```

The dictation orchestrator pings `/voice-tick` once per minute while a WS session is active, attributed to the user's virtual key. LiteLLM ticks down the budget like any other charge.

### 7.3 Session lifecycle

```
on POST /api/ai/dictate/token:
  remaining = GET litellm /key/info
  if remaining < $0.003 (one-minute floor):
    reject 402, surface "out of credits" UI
  mint dictate JWT, return to client

on WS open:
  acquire Valkey single-session lock                  # existing logic, unchanged
  open Voxtral Realtime WS direct (NOT via LiteLLM)
  start 60s tick interval

every 60s of audio actually flowing:
  POST litellm /voice-tick with user's virtual key
  if response is 4xx (budget exhausted): close WS with code 1011 reason "budget_exhausted"
  optionally: re-read /key/info, if remaining < $0.003 also close

on session close (client close, idle timeout, daily cap, or budget_exhausted):
  if leftover_seconds > 0: round up — final tick (don't refund)
  release Valkey lock
```

### 7.4 Granularity vs overrun

A user can talk past zero by up to one tick interval.

| Tick rate | Max overrun cost | LiteLLM write rate |
|---|---|---|
| 60s ($0.003/tick) | $0.003 (~0.3 credits) | 1/min/session |
| 30s ($0.0015/tick) | $0.0015 | 2/min/session |
| 10s ($0.0005/tick) | $0.0005 | 6/min/session |

**Decision: 60s ticks**. Overrun of 1 credit on a 1000-credit budget is rounding noise. The existing 30 min/day per-user voice ceiling already prevents serious abuse.

**Round up, don't refund.** Simpler accounting; "one extra credit per session" is a feature, not a bug.

### 7.5 What this gives us

- Single source of truth: voice spend appears in the same `/key/info` response that the prompt-bar credits-remaining UI reads.
- No double-bookkeeping: `ai_usage_period` deleted, voice metering replaced by (LiteLLM cost) + (Valkey concurrency lock) + (in-memory per-session tick counter).
- Clean failure mode: WS closes mid-session with `code: 1011, reason: "budget_exhausted"`. Frontend already handles WS close events.
- Pricing migration is a config edit: if we self-host Voxtral Realtime later, change the per-request cost on `/voice-tick`.

### 7.6 What this doesn't give us

- Per-second precision in the LiteLLM dashboard. UX-precision (e.g. "3 min 47 sec used today") comes from our own session-tick counter, not LiteLLM aggregations.
- Real-time hard cutoff. A user can complete one tick (≤60s) of audio after going broke. Bounded, advertised.

---

## 8. What we delete from our codebase

| Path | Reason |
|---|---|
| `server/db/schema.ts` — `ai_usage_period` table | LiteLLM owns budget state |
| Drizzle migration to drop `ai_usage_period` | data goes away with table |
| `server/utils/billing.ts` — atomic interaction counter logic | LiteLLM tracks |
| `server/utils/agentic/runLoop.ts` — `incrementAiUsage()` calls | LiteLLM bills per LLM call |
| `server/middleware/*` — per-user AI prompt/transcribe rate limits (20/hr, 60/hr) | LiteLLM RPM/TPM limits replace |
| `server/utils/planLapseSweep.ts` | LiteLLM enforces budget exhaustion natively |
| `nuxt.config.ts:88-129` — `runtimeConfig.google.*` (10 vars) | replaced by `runtimeConfig.litellm.*` (3 vars) |
| `server/plugins/01-validate-secrets.ts` — Google validators | replaced by LiteLLM validators |
| `package.json` — `@google/genai`, `@google-cloud/speech` | unused after migration |
| `nitro.externals.traceInclude: ['node_modules/ws/index.js']` | was a workaround for `@google/genai`'s transitive `ws`; gone |

**Net codebase delta:** ~400 LoC removed across server-side (Stripe-AI plumbing, rate limits, sweepers), ~150 LoC added (LiteLLM client wrappers, virtual-key sync, voice tick orchestrator). **Net negative.**

---

## 9. What we KEEP (LiteLLM can't or shouldn't do these)

| Component | Why kept |
|---|---|
| `runLoop.ts` per-tool call-count caps + per-session interaction cap (50) | These prevent pathological loops, not cost. A model looping `view_image` 200× would exhaust the user's credit fast but still be 200 seconds of bad UX. Cost-limiting is necessary but not sufficient. |
| Live dictation single-session Valkey lock (`SET NX`) | Concurrency control, orthogonal to cost. |
| Live dictation 30 min/user/day ceiling | Defense-in-depth against runaway sessions. LiteLLM is the cost oracle, not the only gate. |
| Live dictation 10 min/session, 30s idle timeout | UX/safety, not cost. |
| Workspace billing attribution (`workspaces.ai_enabled`, `billing_owner_id`) | Routing decision happens in our app; LiteLLM doesn't model workspaces. |
| Knowledge upload limits (file count, MB, presign rate) | Storage limits, orthogonal to AI spend. |
| Stripe webhook idempotency (`processed_webhook_events`, `pending_stripe_events`) | Webhook-correctness layer; LiteLLM is downstream of this. |
| `users.plan` + `plan_valid_until` columns | Display + plan-lapse logic; LiteLLM only knows budget numbers. |

---

## 10. New code we own

| Component | Effort |
|---|---|
| LiteLLM client wrapper (`server/utils/litellm.ts`) — typed wrappers over `/key/*`, `/spend/*`, `/voice-tick` | 0.5d |
| Stripe webhook → LiteLLM virtual-key sync (`server/utils/stripeWebhook.ts` additions): `invoice.paid` → `POST /key/update`, `customer.subscription.updated` → tier change, signup → `POST /key/new` | 1d |
| Workspace-aware key routing in `server/utils/billing.ts` — return either user's key or workspace owner's key based on `workspaces.ai_enabled` | 0.5d |
| Voice tick orchestrator in `server/routes/api/ai/dictate.ts` — 60s timer, `/voice-tick` POST, budget exhaustion → WS close | 1d |
| `/api/ai/budget` proxy endpoint — fetches `/key/info` from LiteLLM and surfaces remaining-credits to frontend | 0.5d |
| `users.litellm_key_id` column + Drizzle migration | 0.25d |
| `/internal/litellm-noop` endpoint (target for `/voice-tick` pass-through, returns 200) | 0.25d |
| Test mocks for LiteLLM in `tests/integration/setup/` | 0.5d |

**Total new code: ~4 engineer-days.**

---

## 11. Schema migrations & data steps

### 11.1 Embeddings re-index (one-time)

**Safe-because-MRL:** since we keep `vector(768)` and the HNSW index, this is data-only, no DDL.

Steps:
1. Deploy new code path (Jina embeddings v4 truncated to 768-d) behind a feature flag.
2. Run a one-shot script (`scripts/re-embed-knowledge.ts`):
   ```
   for each row in workspace_knowledge_chunks:
     fetch jina v4 embedding for chunk.content
     UPDATE chunk SET embedding = new_vector
   ```
3. Throttle to ≤ N rows/sec (Jina rate limits).
4. Idempotent — re-running re-embeds again, no harm.
5. Cutover: flip the feature flag globally.

**Risk:** during the re-embed window (estimate: a few hours for current data volume), retrieval quality is mixed (some chunks new-space, some old-space). Mitigation:
- Take the 300-line `processKnowledge` ceiling as a budget guide — total chunks across all workspaces is bounded.
- Run during low-traffic window.
- Or: run the re-embed before flipping the read path, then flip atomically. **Preferred.**

### 11.2 LiteLLM Postgres setup

LiteLLM needs Postgres for spend logs and virtual-key storage. **Reuse our managed Postgres** with a separate database (not a separate schema — LiteLLM's migrations expect a clean DB).

```yaml
# docker-compose.base.yml
litellm:
  image: ghcr.io/berriai/litellm:main-stable
  environment:
    DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/litellm
    LITELLM_MASTER_KEY: ${LITELLM_MASTER_KEY}
    LITELLM_SALT_KEY: ${LITELLM_SALT_KEY}
  volumes:
    - ./infra/litellm/config.yaml:/app/config.yaml:ro
  command: --config /app/config.yaml --port 4000
```

Backup considerations: LiteLLM's spend-logs table grows unbounded. Add a retention sweeper (drop rows older than 90d). Document in `docs/RUNBOOK.md`.

### 11.3 New env vars

Add to `.env.example` and `server/plugins/01-validate-secrets.ts`:

```
NUXT_LITELLM_URL                # internal URL, e.g. http://litellm:4000
NUXT_LITELLM_MASTER_KEY         # for admin operations (key creation, etc.)
NUXT_LITELLM_IMAGE_MODEL        # default: black_forest_labs/flux-2-pro
NUXT_LITELLM_TEXT_MODEL         # default: mistral/mistral-medium-3
NUXT_LITELLM_EMBEDDING_MODEL    # default: jina_ai/jina-embeddings-v4
NUXT_LITELLM_RERANKER_MODEL     # default: jina_ai/jina-reranker-v3
NUXT_LITELLM_VOICE_TICK_PATH    # default: /voice-tick
```

Removed env vars (delete from `.env.example`):
```
NUXT_GOOGLE_GEMINI_API_KEY
NUXT_GOOGLE_SPEECH_TO_TEXT_API_KEY
NUXT_GOOGLE_DICTATE_JWT_SECRET   # falls back to NUXT_JWT_SECRET; fine
NUXT_GOOGLE_MODEL
NUXT_GOOGLE_IMAGE_MODEL
NUXT_GOOGLE_IMAGE_RESOLUTION
NUXT_GOOGLE_EMBEDDING_MODEL
NUXT_GOOGLE_EMBEDDING_DIMS
NUXT_GOOGLE_SPEECH_MODEL
NUXT_GOOGLE_THINKING_BUDGET
```

LiteLLM's own config (Mistral / Jina / BFL keys) lives in `infra/litellm/config.yaml`, not Nuxt env. Smaller secret blast radius from a Nuxt env leak.

---

## 12. Open questions to verify before merging

| # | Question | How to verify | If "no" |
|---|---|---|---|
| 1 | Does LiteLLM pass-through enforce budgets? Docs are silent. | Create a test virtual key with `max_budget=$0.001`, hit the pass-through endpoint twice. Second call should 4xx. | Wrap the `/voice-tick` and Jina pass-through calls in our own `/key/info` pre-check (one extra HTTP roundtrip). Adds ~50 LoC. |
| 2 | Does `LiteLLM_SpendLogs` table handle high write volume? Voice ticks at 1/min/session × N concurrent users = potentially thousands of rows/hr. | Load test with 100 concurrent simulated voice sessions for 1 hour. Check write latency, table size growth. | Aggregate ticks (e.g. 5-min batch writes via custom logger callback) instead of per-tick. |
| 3 | Does Jina embeddings v4 honor `dimensions: 768` parameter via LiteLLM's OpenAI-compat shim? | Real call: `openai.embeddings.create({ model: 'jina_ai/jina-embeddings-v4', dimensions: 768, input: 'test' })`. Verify `len(response.data[0].embedding) == 768`. | Fall back to v3 ($0.02/M, MRL also supports 768). Slightly older model but well-tested. |
| 4 | Does Jina v4 expose the `task` parameter for RETRIEVAL_DOCUMENT vs RETRIEVAL_QUERY through LiteLLM? | Inspect LiteLLM's Jina provider code. | Pass via `extra_body`. If not possible, accept ~5% retrieval-quality drop. |
| 5 | Does Voxtral Realtime require a Mistral SDK-specific WS protocol or is plain WS sufficient? | Read Mistral's `RealtimeConnection` SDK code; check if it's just framing on top of WS or has handshake quirks. | Use the official Mistral SDK — adds a dependency but de-risks the protocol. |
| 6 | Does Mistral's response_format `json_schema` support all the constraints we use in `fetch_url`'s schema? | Port `functionTools.ts:865-866` schema and run a real call with sample HTML. | Fall back to two-call pattern: free-text response, then a deterministic JSON parser. |
| 7 | Pass-through endpoint authentication: does LiteLLM accept a Bearer token in the `Authorization` header for pass-through, or does it require a custom header? | Read pass-through docs more carefully + test. | Adjust client headers; trivial. |
| 8 | Voice tick-per-minute total: does it count against the user's TPM/RPM rate limit configured on the virtual key? | Set tight RPM limit on a test key, run a voice session. | Disable RPM/TPM on virtual keys; budget is the only gate. |

These should all be answered in a 1-day spike before the main migration starts.

---

## 13. Known regressions (accept and document)

| Regression | Magnitude | Mitigation |
|---|---|---|
| **No automatic prompt caching** | At Mistral Medium 3 input ($0.40/M) with 5k cached tokens × 75% = ~$0.0015 saved per cached turn on Gemini. We lose this. Real but small at our scale. | Trim system prompt + tool declarations. The 50-interaction per-session cap already bounds session length. |
| **STT language coverage 50+ → 13** | Voxtral covers en, zh, hi, es, ar, fr, pt, ru, de, ja, ko, it, nl. Our i18n UI ships in `en/de/fr/es/ja/zh` → fully covered. Anyone dictating in Polish, Turkish, Vietnamese, etc. silently loses dictation. | Document in dictation language picker. Optional future work: keep Cloud STT as a sidecar for unsupported languages (carries dual-vendor secret-rotation overhead). |
| **`generate_image` cost up vs Gemini** | Wait — actually DOWN: $0.045 → $0.030. **No regression here.** | n/a |
| **No equivalent to Gemini's `thinkingBudget`** | We currently default it to 0 anyway. If we ever turn it on, Mistral Medium 3.5 / Magistral fills the slot. | n/a |

---

## 14. Phased rollout

Designed to land low-risk wins first and build confidence before the high-blast-radius changes.

### Phase 1: Zero-risk wins (~3 days)
1. Stand up LiteLLM Proxy container in dev. Wire it to managed Postgres.
2. Migrate batch STT to Voxtral via LiteLLM (`transcribe.post.ts`). 5–16× cheaper, unrelated to text loop.
3. Add Jina reranker as third stage on hybrid search (`server/repos/knowledge.ts`). Pure quality upgrade, opt-in.

**Stop and validate.** Production-deploy. Watch error rates, cost dashboard, retrieval quality metrics for 1 week.

### Phase 2: Embeddings cutover (~2 days)
4. Deploy Jina v4 embedding code path behind feature flag.
5. Run re-embed script during low-traffic window.
6. Flip feature flag.

**Stop and validate.** 1 week.

### Phase 3: Text loop + tool rewrites (~5 days)
7. Migrate text agentic loop to Mistral via LiteLLM (`runLoop.ts`, `prompt.post.ts`, `trigger-ai.post.ts`).
8. Rewrite `web_search` to use Jina pass-through.
9. Rewrite `fetch_url` to use Jina pass-through + Mistral structured output.
10. Migrate `generate_image` to BFL via LiteLLM.
11. Migrate vision input to Pixtral.

### Phase 4: Voice + budget unification (~2 days)
12. Live dictation WS to Voxtral Realtime.
13. Voice tick orchestrator + `/voice-tick` pass-through.
14. Stripe webhook → LiteLLM virtual-key sync.
15. Delete `ai_usage_period` + rate-limit middleware.

### Phase 5: Cleanup (~1 day)
16. Remove Google SDK deps from `package.json`.
17. Update `.env.example`, `docs/SECRETS-ROTATION.md`, `AGENTS.md` (the §2 / §10 entries about Gemini gotchas).
18. Update `docs/RUNBOOK.md` with LiteLLM troubleshooting.
19. Add LiteLLM healthcheck to Traefik.

**Total: ~13 days with validation pauses; ~9 days of pure engineering time.**

---

## 15. Risk register

| Risk | Likelihood | Blast radius | Mitigation |
|---|---|---|---|
| LiteLLM Proxy outage = all AI down | Medium | High | Aggressive healthchecks; LiteLLM's own provider-fallback config; document recovery in RUNBOOK. Single-VPS reality means LiteLLM down ≈ Nuxt down anyway. |
| Mistral API outage | Low | High | LiteLLM model-fallback list (e.g. fall back to Anthropic via OpenRouter for text). Add as Phase 6 if needed. |
| Re-embed script fails partway | Low | Medium | Idempotent, resumable (filter `WHERE embedding_version != 'jina-v4'`). |
| Mistral Medium 3 quality regression on our agentic eval | Medium | Medium | A/B test in dev. If degraded, switch default to Mistral Large 3 (+5% cost, materially better). |
| LiteLLM_SpendLogs table balloon | Medium | Low | 90-day retention sweeper. Document in RUNBOOK. |
| Voice tick race: WS closes mid-tick, charge applied for partial minute | Low | Trivial | Round up by design (§7.4). User-facing acceptable. |
| Workspace owner's virtual key exhausted, members blocked | Medium | Medium | Surface "workspace AI budget exhausted, contact owner" UI. Same blast radius as today's "workspace billing owner plan lapsed". |
| Stripe webhook delivers `invoice.paid` after LiteLLM key already created at signup | Low | Low | Idempotent `POST /key/update` — safe to call repeatedly. |
| Pass-through cost-per-request is approximate (e.g. r.jina.ai sometimes returns 2 pages of content) | Low | Low | Set cost slightly higher than median ($0.005 covers up to ~5-page pages). Round up by design. |

---

## 16. Effort estimate (engineer-days)

| Phase | Item | Est. |
|---|---|---|
| 0 | Verify open questions in §12 (1-day spike) | 1 |
| 1 | LiteLLM container + Postgres + initial config | 0.5 |
| 1 | Voxtral batch STT migration + tests | 1 |
| 1 | Jina reranker integration + hybrid-search update | 1 |
| 2 | Jina v4 embeddings code path + feature flag | 0.5 |
| 2 | Re-embed script + dry-run + execution | 1 |
| 3 | Text agentic loop port (Gemini → Mistral via LiteLLM) | 2 |
| 3 | Prompt re-tuning + agentic eval pass | 1 |
| 3 | `web_search` rewrite via Jina pass-through | 0.5 |
| 3 | `fetch_url` rewrite via Jina pass-through + JSON-schema follow-up | 0.5 |
| 3 | Image gen → BFL FLUX.2 [pro] | 0.5 |
| 3 | Vision-input adapter (Pixtral / Medium 3.5) | 0.5 |
| 4 | Voxtral Realtime WS + mock rewrite | 1 |
| 4 | Voice tick orchestrator + `/voice-tick` pass-through | 1 |
| 4 | Stripe webhook → LiteLLM key sync | 1 |
| 4 | Delete `ai_usage_period` + rate-limit middleware | 0.5 |
| 5 | Cleanup (deps, docs, RUNBOOK, healthchecks) | 1 |
| | **Total** | **~14 days** |

Real-world buffer: **2 weeks for a senior, 3 weeks for someone unfamiliar with the codebase.**

---

## 17. Rollback plan

The migration is split into phases so each is independently reversible.

| Phase | Rollback cost |
|---|---|
| 1 (STT batch + reranker) | Revert PR. ~30 min. No data loss. |
| 2 (embeddings) | Re-run a reverse re-embed against old Gemini model. Schema unchanged. ~2 hours during low-traffic window. **Required: keep Gemini key valid for 30d after embeddings cutover.** |
| 3 (text loop + tools) | Revert PR. Existing Gemini key + env vars still valid (don't delete until Phase 5). ~30 min. |
| 4 (voice + budget) | More involved — `ai_usage_period` table is dropped. Rollback requires restore from backup. **Take a fresh `pg_dump` immediately before Phase 4 PR merges.** |
| 5 (cleanup) | Trivial — re-add deps + env vars. |

**Important:** Phase 4 is the irreversible step (drops `ai_usage_period`). Hold the dependency keys (Gemini, Cloud STT) for at least 30 days post-Phase-4. Document key-rotation in `docs/SECRETS-ROTATION.md` so they don't get auto-rotated out.

---

## 18. Decisions made (for the record)

These are the explicit calls made during planning. If the implementing engineer disagrees with any, escalate before coding.

1. **Default text model: Mistral Medium 3** ($0.40 / $2.00). Cheaper than Large 3 input, only mildly slower. Switch to Large 3 if eval regression > 10% on the agentic suite.
2. **Embeddings: Jina v4 truncated to 768-d via MRL**. Keeps `vector(768)` schema, no DDL. v3 fallback if v4 commercial pricing is bad.
3. **Reranker: jina-reranker-v3** as a third stage on hybrid search. Pure quality add, low cost.
4. **Web search: Jina `s.jina.ai`** via LiteLLM pass-through. Not Mistral Agents API (different programming model, more complex migration).
5. **URL read: Jina `r.jina.ai`** via LiteLLM pass-through. Not Mistral Agents API.
6. **Image gen: BFL FLUX.2 [pro]** at $0.03/image. Not via Mistral Agents API (would be 2× more expensive — they wrap FLUX 1.1 Ultra at $0.10/image).
7. **Live dictation: direct WS to Voxtral Realtime**, NOT proxied through LiteLLM. Metered via 60s pass-through ticks.
8. **Tick rate: 60 seconds**. Round up, don't refund.
9. **Budget per Pro user: $10/mo = 1000 credits at $0.01/credit displayed**. ~84% margin over typical use.
10. **Free tier: $0.10 budget = 10 credits**. Same code path, smaller number — no separate handling.
11. **Plan-budget reset: Stripe-webhook-driven**, NOT LiteLLM's `duration` auto-reset (those would drift from billing-cycle anchors).
12. **Workspace billing routing: in our app**, not in LiteLLM. LiteLLM doesn't model workspaces.
13. **Per-tool call caps + per-session interaction cap stay in `runLoop.ts`**. They're not redundant with budgets — they prevent runaway loops, not just runaway cost.
14. **Daily voice cap (30 min/user/day) stays as a separate ceiling**. Defense-in-depth.
15. **Accept loss of Gemini implicit prompt caching** as a known cost regression (~$0.0015 per long-session turn). Don't try to replicate it on Mistral.
16. **Accept STT language coverage drop** (50+ → 13). Document in dictation UI. No fallback Cloud STT — too much dual-vendor overhead.
17. **LiteLLM Postgres**: separate database on the same managed Postgres instance. Not a separate schema (LiteLLM migrations expect clean DB).
18. **LiteLLM master key + provider keys live in LiteLLM config**, NOT in Nuxt env. Smaller blast radius from a Nuxt env leak.
19. **Phased rollout in 5 phases, not big-bang**. Each phase is independently revertible (with the caveat that Phase 4 drops a table).
20. **Hold Google API keys for 30 days post-Phase-4** in case of rollback.

---

## 19. References

- LiteLLM virtual keys: https://docs.litellm.ai/docs/proxy/virtual_keys
- LiteLLM budgets & rate limits: https://docs.litellm.ai/docs/proxy/users
- LiteLLM Mistral provider (incl. Voxtral): https://docs.litellm.ai/docs/providers/mistral
- LiteLLM Jina AI provider: https://docs.litellm.ai/docs/providers/jina_ai
- LiteLLM Black Forest Labs provider: https://docs.litellm.ai/docs/providers/black_forest_labs
- LiteLLM pass-through endpoints: https://docs.litellm.ai/docs/proxy/pass_through
- LiteLLM Spend Tracking: https://docs.litellm.ai/docs/proxy/cost_tracking
- LiteLLM Custom LLM Pricing: https://docs.litellm.ai/docs/proxy/custom_pricing
- Mistral pricing: https://mistral.ai/pricing
- Mistral function calling: https://docs.mistral.ai/capabilities/function_calling
- Mistral structured outputs: https://docs.mistral.ai/capabilities/structured_output
- Mistral vision (Pixtral / Medium 3.5): https://docs.mistral.ai/capabilities/vision
- Voxtral Transcribe 2 announcement: https://mistral.ai/news/voxtral-transcribe-2
- Voxtral Realtime model card: https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602
- Jina embeddings v4: https://jina.ai/models/jina-embeddings-v4/
- Jina reranker v3: https://jina.ai/models/jina-reranker-v3/
- Jina Reader API: https://jina.ai/reader/
- Jina Search grounding: https://jina.ai/news/jina-reader-for-search-grounding-to-improve-factuality-of-llms/
- Black Forest Labs pricing (FLUX.1 + FLUX.2 + Kontext + Fill): https://docs.bfl.ai/quick_start/pricing
- Gemini implicit caching (75–90% discount, baseline we're losing): https://developers.googleblog.com/gemini-2-5-models-now-support-implicit-caching/
