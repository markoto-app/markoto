# AI Features — Gemini + Cloud Speech-to-Text

Two Google vendors: **Gemini** (Generative Language API, via `@google/genai`) for all generative flows, **Google Cloud Speech-to-Text** (v1 via `@google-cloud/speech`) for all speech transcription. Keys are split per-API in GCP so a compromise of one doesn't pivot to the other. Read via `config.google.geminiApiKey` / `config.google.speechToTextApiKey`.

## Four flows

- **Agentic prompt** — one path serving both the bottom `AIPromptBar.vue` and the selection-scoped `AISelectionPopup.vue`. Full tool use: **21 always-on tools + 2 workspace-gated knowledge tools**. The 21 break down as 16 doc/theme/web/render tools (`view_document`, `replace_text`, `insert_text`, `web_search`, `update_theme`, `get_theme`, `list_themes`, `save_theme_as_preset`, `list_workspace_documents`, `view_other_document`, `set_title`, `view_image`, `generate_image`, `get_page_count`, `view_pages`, `fetch_url`) + 5 comment tools (`read_comments`, `create_comment`, `reply_to_comment`, `resolve_comment`, `delete_comment`). Knowledge gates on (workspace membership AND ≥1 ready file). Model: `NUXT_GOOGLE_MODEL` (default `gemini-3.1-flash-lite-preview`). Image generation uses `NUXT_GOOGLE_IMAGE_MODEL` (default `gemini-3.1-flash-image-preview`). Embeddings use `NUXT_GOOGLE_EMBEDDING_MODEL` (default `gemini-embedding-2-preview`, 768-d via `outputDimensionality` MRL). The selection popup pre-captures an `EditorSelectionSnapshot` (kind=`selection`) and passes it as `editorSelection` on `/api/ai/prompt`, so the model sees the range inside `<editor_state>` and picks `replace_text` accordingly.
- **`@ai` mention in a comment thread** — `POST /api/docs/:docId/comments/:commentId/trigger-ai` with `{replyId?}`. Fired automatically by `CommentsPanel.vue` after a successful comment / reply commit whose body matches `\b@ai\b` (case-insensitive). Spawns a regular agentic loop with three differences: (1) the system prompt is the comment-trigger flavour from `commentTriggerPrompt.ts` — forbids `create_comment`, mandates a closing `reply_to_comment`, won't `resolve_comment` unless explicitly asked; (2) a `<comment_trigger>` block prepended to the system prompt carries the resolved thread state (anchored line range + text, parent comment, full reply chain, with the triggering message marked); (3) the seed user-prompt is the triggering body with `@ai` stripped, AND the server synthesizes an `EditorSelectionSnapshot` of `kind: 'selection'` from the comment's anchor so the existing editor-state routing rules steer the model to `replace_text` against the anchored span (without the synthesis the model defaulted to `insert_text` at EOF for "rewrite this" requests). Awareness `aiSession.commentThreadId` rides on every session so all clients can render a per-thread rainbow ring + "AI is responding…" indicator. Loop guards: `resolveCommentTrigger` returns null when the triggering message is AI-authored, and `handleCreateComment` / `handleReplyToComment` strip outgoing `@ai` substrings so AI replies can't re-trigger themselves. Auth = same as `/api/ai/prompt`; anonymous editors typing `@ai` get a no-op (the client checks `viewerId` before firing).
- **Voice input for the prompt bar** (mic button inside `AIPromptBar.vue`) — one-shot transcription via Cloud STT sync `speech:recognize`. `MediaRecorder` + `AnalyserNode` visualiser in `useVoicePrompt.ts`, POSTs base64 audio + MIME + languageCode to `/api/ai/transcribe` → Cloud STT → plain text → auto-submits as a normal prompt. 60s cap, 5 MiB max. No Y.js session — transcription itself doesn't touch the doc; the downstream `/api/ai/prompt` call enforces all the usual content gates.
- **Live dictation into the editor** (mic button in the formatting toolbar) — streaming transcription via Cloud STT `streamingRecognize` over a Nitro WebSocket at `/api/ai/dictate`. Interim partials render as ghost text at the CM6 caret; finals commit into Y.js with a `dictation:{userId}` origin. Auth via short-lived JWT sent as the FIRST WS message (NOT `?token=`, which would leak into access logs). One session per user enforced via Valkey `SET NX EX` lock keyed on `lock:ai-dictate-active:{userId}`. Audio-seconds metered into a daily budget. See `useVoiceDictation.ts` + `dictationExtensions.ts` + `server/routes/api/ai/dictate.ts`.

## Document context block

`server/utils/agentic/documentContextPrompt.ts`: every system prompt is prepended with a `<document_context>` block carrying the doc's `title`, `description` (omitted if empty), `language` (resolved to its self-display name via `Intl.DisplayNames` — `de` → "Deutsch"), and the audience-specific tone fragment from `shared/audiences/index.ts`. The schema enforces NOT NULL with sensible defaults (`description=''`, `audience='casual'`, `language='en'`), so this block is **always** present — the AI gets durable doc context every turn without the user re-typing. Free-text languages ("Schwiizerdütsch", "Romansh") pass through verbatim into the "Write all prose in X" instruction.

## Thinking budget

`NUXT_GOOGLE_THINKING_BUDGET` (default `0` = disabled, cheapest/fastest). Applied only to the main agentic loop. We only pass `thinkingConfig` when `budget > 0` — some models (older `flash-lite`) 400 on an empty thinkingConfig.

## AI-as-Y.js-client

Server mints a JWT (`userId=ai:assistant:{sessionId}`), opens a `HocuspocusProvider`, sets awareness `{isAI, aiSession, aiStatus}`. Each edit is `ydoc.transact(fn, 'ai:assistant:{sessionId}')` — users watch edits land in real time. No SSE; status rides on awareness. The `AiSession` interface exposes `docId` and `initiatorUserId` so tools can attribute audited writes (e.g. `uploads.uploaderId` from `generate_image`) to the real human initiator rather than the synthetic AI principal.

## Function tools

`functionTools.ts` + `../aiToolAdapter.ts`:

| Tool | Behavior |
|---|---|
| `view_document({ view_range? })` | Returns `ytext.toString()` with 1-indexed line prefixes. Schema refines `start >= 1` so `[-1,-1]` is caught at Zod, not the handler. |
| `replace_text({ old_str, new_str })` | 0 matches → error; 2+ → "Found N matches"; 1 → transact delete+insert. |
| `insert_text({ insert_line, insert_text })` | Maps line → char idx via shared `lineToCharOffset`; transacts insert. |
| `update_theme({ preset?, page?, body?, … })` | Partial theme patch. `preset` (`modern`/`academic`/`tech`/`business`/`novel`/`newsletter`) replaces base; other fields merge on top. Validates via `isValidTheme`, writes `ymeta.theme` + persists to `documents.theme` JSONB. |
| `set_title({ title })` | Trim + 1–255 bound; writes `ymeta.title` + persists via `updateDocMeta`. |
| `view_image({ src })` | Fetches image bytes and smuggles them back to the model via `inlineData` on the next turn (Gemini functionResponse is JSON-only — see `ToolResult.extraParts` below). Internal `/api/files/{docId}/{fileId}` → S3 direct (with cross-doc rejection); external `http(s)://` → `fetch` with 10s timeout + 5 MiB cap + MIME allowlist. |
| `generate_image({ prompt, alt })` | Gemini image-model sub-call (`responseModalities: ['IMAGE','TEXT']`) → S3 upload → uploads row (pending+confirmed) → returns markdown reference. AI follows up with `insert_text`/`replace_text` — the tool does not place it. Server-side PUTs deliberately omit the per-object `ServerSideEncryption` header — SeaweedFS rejects unknown SSE headers with "internal error" and the browser presigned-PUT path already trusts the bucket-default encryption (so keeping both paths symmetric prevents one prod bucket-policy change from silently breaking only the AI-image flow). |
| `web_search({ query })` | Isolated sub-call with `googleSearch` grounding only. Freeform answer text + deduped sources from `groundingMetadata` (never mixed with `functionDeclarations` or `responseSchema` — coexistence 400s across model versions). |
| `fetch_url({ url })` | Isolated sub-call with `urlContext` + structured output (`responseSchema`: `{summary, images[]}`). Returns formatted text the agent can parse. Scheme-less URLs get `https://` prepended. |
| `search_knowledge({ query, top_k? })` | Hybrid search over `workspace_knowledge_chunks` (vector cosine via HNSW + BM25 via `ts_rank_cd`) fused via Reciprocal Rank Fusion (`k=60`). Returns top-K with `semantic=…` + `lexical=…` score breakdown. Only exposed when the session has a workspaceId AND the workspace has at least one `status='ready'` file. |
| `get_knowledge_file({ knowledge_id })` | Returns the cached markdown of one knowledge file, truncated to 40k chars. knowledge_ids come from the `<knowledge_files>` system-prompt block — fabrication is rejected. |
| `read_comments({})` | Walks `Y.Array<Y.Map>` named `comments`, resolves each anchor (`Y.RelativePosition` base64 → from/to chars → line numbers), formats id + anchor preview + author + body + reply chain. Returns `[orphaned]` when an anchor's underlying text was deleted. Strips `@[Name](user:N)` to bare `@Name` for display. |
| `create_comment({ start_line, end_line, body })` | Anchors a new comment via `lineToCharOffset` → `Y.createRelativePositionFromTypeIndex` → `Buffer.from().toString('base64')` (NOT `btoa` — server context). Author is `{authorId: null, authorName: 'AI Assistant'}`. Strips `@ai` from the body before insert (loop guard). |
| `reply_to_comment({ comment_id, body })` | Pushes a reply Y.Map into the parent's `replies` Y.Array, bumps parent `updatedAt`. Same AI-Assistant author + same `@ai` strip as `create_comment`. |
| `resolve_comment({ comment_id, resolved })` | Sets `resolved` on the parent map. No authorization gate — matches client-side semantics where any editor can resolve. |
| `delete_comment({ comment_id, reply_id? })` | Pass `reply_id` to delete one reply; omit it to delete the whole thread. Permitted when authored by AI, by the session initiator, or when `canManageDoc(initiatorUserId, docId)` returns true. |

**Tool declarations are split:** `ALL_TOOL_DECLARATIONS` = the 21 always-on tools (16 doc/theme/web/render + 5 comment); `KNOWLEDGE_TOOL_DECLARATIONS` = the 2 workspace-gated tools. `server/api/ai/prompt.post.ts` concatenates them only when the session has workspace access AND at least one ready knowledge file, AND appends a `<knowledge_files>` block listing `{knowledge_id, filename, sizeBytes, sourceExt, tokenCount}`. **Comment-trigger sessions** use the SAME tool list but a different system prompt (`COMMENT_TRIGGER_SYSTEM_PROMPT`) that bans `create_comment` and mandates a closing `reply_to_comment`.

**`ToolResult.extraParts`:** tools whose output includes binary data (currently `view_image` with inline image bytes) return a `ToolResult` with an `extraParts: Part[]` field; the runLoop appends those sibling parts on the user message AFTER the `functionResponse`. Gemini's `functionResponse.response` is JSON-only — this is the smuggling path for anything non-JSON.

**Source-of-truth for schemas:** Zod drives everything. `z.toJSONSchema(schema, { target: 'draft-7' })` generates both Gemini's param schema and the runtime validator. Drift-prone strings in the system prompt (preset names, font-category hints) are derived at module load from `THEME_PRESETS` / `THEME_FONTS`, so adding a preset/font automatically propagates.

**Authorization:** All AI routes check `requireDocEditAccess(docId, userId)` before starting. Workspace viewers and non-members are blocked there, so every tool inherits "content-edit" permission.

**Limits:** `ai-prompt: 20/h` per user. Prompt deadline 5 min, `MAX_TURNS = 20`. Sweeper aborts sessions >7 min (threshold intentionally above prompt deadline). Error status lingers 2.5s in awareness so clients latch before cleanup.

**Per-session safety caps** (`server/utils/agentic/limits.ts`):
- `SESSION_INTERACTION_CAP = 50` — total interactions any one session can accumulate across turns + sub-calls. A normal session uses 3-8; >50 means tool-call ping-pong, prompt-injection amplification, or a runaway loop. **On hit the loop ABORTS** via the existing `setStatus('error', …)` path — the model doesn't get a chance to recover. These are runaway-loop SAFETY caps; the per-user monthly interaction budget (Stripe-aligned) is the BUSINESS cap. Both layers are needed: a single runaway prompt should never drain a paid user's monthly budget on one session.
- `SESSION_TOOL_CALL_CAPS` — per-tool ceilings within one session: `view_pages: 3`, `generate_image: 5`, `web_search: 10`, `fetch_url: 10`, `search_knowledge: 20`. **On hit returns a TOOL ERROR** (not an abort) — the model sees the cap and can finish its reply gracefully without further tool use. Numbers picked from "what does a pathological loop look like": e.g. 5 image gens × $0.045 = $0.22 worst-case session; 10 grounded searches × $0.017 ≈ $0.17. Above those is research-style usage that should be split across sessions.

**SSRF guard** (`server/utils/agentic/urlGuard.ts`): every URL-taking tool — `view_image` (external `http(s)://` branch), `fetch_url` — calls `assertSafeUrl(url)` before forwarding. Catches private CIDRs (RFC 1918, CGNAT, link-local incl. AWS/GCP metadata `169.254.169.254`, multicast, broadcast), loopback, in-cluster service banners (Postgres / Valkey / Hocuspocus / Nuxt's own internal endpoints), and non-`http(s)` schemes (`file://`, `gopher://`, `dict://`, `ftp://`). DNS-resolved hostnames are looked up once and the resolved IP is checked — DNS rebinding with sub-second TTL flipping public→private mid-resolution is acknowledged out-of-scope. Don't add a new URL-taking tool without routing it through this guard.

**Session telemetry**: every agentic-loop run emits exactly one Sentry event at session-end via `Sentry.captureMessage('ai-session-completed', …)` from the `finally` block in `runLoop.ts`. Tags: `component: 'ai-session'`, `event: 'completed'`, `outcome ∈ {ok, abort, error}`, `docId`, `initiatorUserId`. Extras: `sessionId`, `turnCount`, `totalInteractions`, `totalInputTokens` / `totalOutputTokens` / `totalThinkingTokens` (each `-1` when the SDK never surfaced `usageMetadata` — preserves "no data" vs "actually 0"), `toolCallCounts: Record<string, number>`, `abortReason`, `errorMessage`, `durationMs`. Wrapped in a try/catch so a Sentry transport hiccup never propagates into the agentic loop's caller — failed telemetry must be invisible to the user.

**Cancellation:** `POST /api/ai/abort` — 404 if ended, 403 if not initiator. Status → `{phase:'done', message:'Stopped'}`.

**Per-user cap:** 1 session per user per doc, enforced by Postgres UNIQUE index in `ai_sessions`.

**Frontend status display:** `describeToolInput` in `streamStatus.ts` has a labelled case for every tool. `AIPromptBar.vue` shows the message as the input placeholder; `PresenceBar.vue` appends the status to the avatar tooltip.

## Live dictation stack

**Transport:** Nitro native WebSockets (`nitro.experimental.websocket: true`). Single WS route: `server/routes/api/ai/dictate.ts` implements `{ websocket: { upgrade, open, message, close, error } }` hooks. An HTTP fallback on the same path 426s.

**Protocol** (head-comment in handler):
- Server → client: `{type:'hello'}` on open → `{type:'ready'}` after auth + STT up → `{type:'partial', text}` / `{type:'final', text}` → terminal frames `budget-exhausted` / `session-cap` / `idle-timeout` / `error`.
- Client → server: `{type:'auth', token, languageCode?}` as the FIRST message → binary PCM chunks → `{type:'stop'}`.

**Text-vs-binary detection:** crossws + the Node `ws` library deliver TEXT frames as Buffer, so `typeof rawData === 'string'` never matches. `tryParseControl` in `dictateHelpers.ts` peeks the first byte for `{` (0x7B) before attempting `JSON.parse` + whitelisting `type` — audio chunks that coincidentally start with `{` don't get routed as control frames.

**Auth lifecycle:** `POST /api/ai/dictate/token` mints a 60s JWT signed with `config.google.dictateJwtSecret` (falls back to `config.jwtSecret` for dev). Middleware whitelists `/api/ai/dictate` because the WS upgrade hook gets a raw Request (not an H3Event). The `open` hook arms a 5s auth-deadline timer.

**Concurrent-session cap:** `tryAcquireSessionLock('ai-dictate-active', userId, SESSION_HARD_CAP_MS)` — Valkey `SET NX PX` cluster-wide. Fails CLOSED on Valkey errors (correctness lock; failing open would double-bill GCP). Released on every WS close/error hook.

**Audio-seconds budget:** `consumeRateLimitBudget('ai-dictate-ms', userId, CHUNK_AUDIO_MS, DAILY_BUDGET_MS, DAILY_WINDOW_MS)` — 30 min/user/day in ms, not requests. Each AudioWorklet chunk (2048 samples @ 16 kHz = 128 ms) debits 128. Peek mode (`cost: 0`) returns the REAL remaining (`maxCost - current`) — naive `maxCost` would let exhausted users open then trip on first chunk.

**Client state machine** (`useVoiceDictation.ts`): `idle → requesting-permission → connecting → recording → idle/error`. VueUse: `useUserMedia` for stream lifecycle (explicit `track.stop()` on unmount), `useWebSocket` with both `immediate: false` AND `autoConnect: false` (default `autoConnect:true` watches the URL ref and races the explicit `.open()` call → spawns TWO sockets per click).

**CM6 integration** (`app/utils/dictationExtensions.ts`): `StateField<string>` holds interim text, `ViewPlugin` rebuilds a `Decoration.widget` at the caret on every state-field/doc/selection change. `commitDictationFinal` inserts via `ydoc.transact(fn, 'dictation:{userId}')` with smart spacing (mid-word `fo|o` + "bar" → `fo bar o`).

**Straggler-chunk guard:** `stt.end()` on `{type:'stop'}` sets `ctx.sttEnded = true`. Audio chunks already queued by the browser's worklet → postMessage queue → WS pipeline (~128 ms window) land post-end; the flag drops them before they hit `stt.write()`. Second defense: SpeechClient's error listener silently swallows "write after end" when the flag is set.

**Mock for tests:** `createDictateSpeechClient(apiKey)` returns a real SpeechClient or, when `TEST_MODE=1` + `NUXT_GOOGLE_SPEECH_MOCK=1`, a fake that emits canned interim → final responses on fixed chunk thresholds.

## Gotchas

- **Zod `z.tuple(...)` rejected by Gemini** — use `.array().min(N).max(N)`.
- **AI sweeper threshold must exceed prompt deadline** (7 min > 5 min) — otherwise legit long web searches get killed.
- **Gemini image model names drift** — verify with `curl "https://generativelanguage.googleapis.com/v1beta/models?key=$KEY"` before setting `NUXT_GOOGLE_IMAGE_MODEL`. `gemini-2.5-flash-image-preview` is NOT real (no `-preview`); correct names are `gemini-2.5-flash-image` (stable) and `gemini-3.1-flash-image-preview` (current preview).
- **Gemini sometimes hallucinates tool outputs** — placeholder URLs like `/api/files/placeholder/joel.png`. System prompt explicitly forbids fabricating `/api/files/...` paths.
- **`googleSearch` + `responseSchema` coexistence 400s on some models** — stick to freeform text + `groundingMetadata` for grounded sub-calls. `urlContext` + `responseSchema` does work.
- **`z.string().trim().min(1)` ordering matters in Zod 4** — put `.trim()` BEFORE `.min(1)` so the length check sees the trimmed value.
- **`view_range: [-1, -1]` keeps coming back** — enforce `start >= 1` with a `.refine` so Gemini gets a schema-level rejection it self-corrects from.
- **`@mdit/plugin-alert` doesn't support `> [!NOTE] Custom title`** — text after `[!KIND]` on the first line is silently dropped.
- **`data-*` attributes don't survive DOMPurify** — only `class`, `id`, `style`, `width`, `height`, `aria-*`, `role`, `target`, `rel`, `title` survive on most elements.
- **`responseModalities: ['IMAGE', 'TEXT']`** required on image-gen calls. If the response has no `inlineData` part, surface the finish reason + text (usually a safety block).
- **AI `extraParts` must come AFTER the `functionResponse`** — Gemini links binary parts to the most-recent function call on the same user message.
- **`MediaRecorder` MIME preference** — Chrome/Firefox want `audio/webm;codecs=opus`, Safari falls back to `audio/mp4`. Server's `ALLOWED_MIME` list must stay in lockstep or Safari recordings 400.
- **Always `track.stop()` on every `MediaStream` track explicitly** — just stopping `MediaRecorder` leaves the audio tracks live and the browser's "site is using your microphone" indicator stays on.
- **`String.fromCharCode(...bytes)` blows the stack on large buffers** — chunk in 0x8000-byte slices when converting audio `ArrayBuffer` → base64.
- **Gemini transcription: dummy API key returns HTTP 400**, not 500. Integration tests must check the error message, not just the status code.
- **`useWebSocket` has TWO independent flags** — `immediate` AND `autoConnect`, both default true. Set both to false for manual lifecycle control.
- **`@google-cloud/speech` streaming: `stream.write(buf)` NOT `stream.write({ audioContent: buf })`** — the helper's internal PassThrough wraps each Buffer as `{ audioContent }` before forwarding to gRPC. README example showing `stream.write(request)` is wrong/outdated.
- **`@google-cloud/speech` SpeechClient `apiKey` option isn't in the TS types** — needs `@ts-expect-error` but works at runtime.
- **Cloud STT v1 sync `recognize` doesn't accept MP4/AAC** — only `WEBM_OPUS`, `OGG_OPUS`, `LINEAR16`, `FLAC`, `MULAW`, `AMR`, `AMR_WB`. Safari's MediaRecorder default is rejected.
- **Cloud STT model names:** v1 has `latest_long` (dictation-tuned) and `latest_short` (chops long dictation). `chirp_2` is v2-only and requires a project id in the recognizer path; not usable with v1 sync via API key.
- **`tryAcquireSessionLock` fails CLOSED, `consumeRateLimitBudget` fails OPEN** — opposite polarity by design. Don't accidentally flip either.
- **`consumeRateLimitBudget` with `cost: 0` must PEEK the actual remaining** — earlier version returned `maxCost` unconditionally which let exhausted users open then trip on first chunk.
- **JWT in first WS message, NOT `?token=`** — query-string auth leaks into access logs, referer headers, and browser history.
- **Knowledge tools are in a SEPARATE declaration array** — `KNOWLEDGE_TOOL_DECLARATIONS` is concatenated to `ALL_TOOL_DECLARATIONS` only when the session has workspace access AND ≥1 ready file.
- **AI must end every turn with `insert_text`/`replace_text`** — there's no chat surface for model prose. System prompt makes this explicit + bans clarifying questions.
- **`@ai` is regex-detected at the client, NOT typed-into a structured token.** Detection regex `/(^|[^\w@])@ai(?=[^\w]|$)/gi` — the leading non-`\w`/`@` lookbehind avoids matching emails (`joel@ai.example.com`); the trailing lookahead avoids word extensions (`@aim`, `@aiding`). Server uses the SAME regex (`stripAiMention` / `hasAiMention` in `commentTriggerPrompt.ts`).
- **Anchor base64 on the server uses `Buffer`, NOT `btoa`.** `btoa` is browser-only. Symptom of getting this wrong: `ReferenceError: btoa is not defined` only in the comment-trigger path.
- **The `@ai` trigger endpoint reads the live Y.Doc via `openTrustedCommentClient`, not the AI session's Y.Doc** — peek-only, ~10 ms, doesn't force the full AI session sync.
- **`onSubmitReply` doesn't thread `replyId` through the trigger endpoint yet** — the reply id from `postReply` is not passed up; falls back to the parent body and renders the full reply chain in `<comment_trigger>`. Fix when refactoring `useComments.ts`.
- **`@ai` typeahead row is synthetic; doesn't come from `mentionable-users`** — `CommentsPanel` prepends a `{kind: 'ai', ...}` entry so it surfaces on standalone docs too. The AI entry has no DB row and no avatar.
