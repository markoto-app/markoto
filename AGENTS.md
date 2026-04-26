# YPad — Project Guide

Collaborative markdown editor: Y.js CRDT + Hocuspocus sync, OAuth (GitHub/Google) via `nuxt-auth-utils`, PostgreSQL (app data + Y.js state via `y-postgresql` + pgvector embeddings), external S3 for image uploads & pg backups, multi-lingual UI via `@nuxtjs/i18n`, AI writing assistance via Google Gemini with workspace knowledge-base retrieval. Single Linux VPS, Docker Compose.

Login is **optional** — public docs work anonymously. Login is required to own, manage permissions, use workspaces, delete, or use AI.

---

## 1. Architecture

Browser (Nuxt 4 SSR + SPA with CodeMirror 6, Y.js, paged.js iframe) connects via HTTPS/WSS to Traefik, which routes to the Nuxt app container and the Hocuspocus sync container. Both containers talk to PostgreSQL. App talks to Hocuspocus over internal HTTP. Backup sidecar does daily `pg_dump → S3`. Markitdown (FastAPI) handles imports only.

**Key design principles**
- **Full-stack Nuxt.** One Bun process serves SSR + Nitro API + OAuth. No CDN.
- **OAuth optional.** Anonymous users can view/edit public docs; login gates ownership and AI.
- **Y.js state in Postgres** via `y-postgresql` (`yjs_documents` table). Append-only + periodic merge; one `pg_dump` covers everything.
- **S3 = image uploads, workspace knowledge originals (deleted post-processing), and pg backups.** SeaweedFS in dev; external S3 in prod.
- **Workspace knowledge base.** Files uploaded to a workspace → markitdown → chunked → embedded (Gemini `gemini-embedding-2-preview`, 768-dim MRL) → pgvector HNSW + generated tsvector for hybrid search. Exposed to the AI via `search_knowledge` / `get_knowledge_file` tools, gated on workspace membership.
- **Hocuspocus as separate container.** Long-lived WS shouldn't share the Nitro event loop. Server↔sync over shared-secret HTTP.
- **AI joins the doc as a real Y.js client** — edits broadcast live via CRDT, status via awareness.
- **Preview is paged, in an iframe.** `themeToCss(theme)` drives both live preview AND PDF print. No server Chromium.
- **Markitdown isolated.** Python/FastAPI wrapper; Nuxt image stays lean (~615 MB vs ~1.1 GB for pandoc).

---

## 2. Technology Stack

### Runtime

| Tool | Version | Purpose |
|---|---|---|
| Bun | 1.3.12 | JS/TS runtime + package manager |
| Nuxt | 4.4.2 | Full-stack Vue (SSR + API via Nitro) |

### Nuxt modules

| Module | Version | Purpose |
|---|---|---|
| `@nuxt/ui` | 4.6.1 | Reka UI + Tailwind v4 |
| `nuxt-auth-utils` | 0.5.29 | OAuth + sealed-cookie sessions |
| `@nuxtjs/i18n` | 10.2.1 | 6 languages, lazy-loaded |
| `@vueuse/nuxt` | 14.2.1 | VueUse auto-imports |
| `@pinia/nuxt` | 0.11.3 | State management (must precede Colada) |
| `@pinia/colada-nuxt` | 0.3.2 | `useQuery` / `useMutation` |
| `@vite-pwa/nuxt` | 0.10.6 | PWA/Workbox |
| `nuxt-codemirror` | 0.0.11 | CM6 Vue wrapper |

### Frontend

| Package | Version | Purpose |
|---|---|---|
| `yjs` | 13.6.30 | CRDT doc model |
| `y-codemirror.next` | 0.3.5 | CM6 ↔ Y.js with remote cursors |
| `@hocuspocus/provider` | 3.4.4 | WS provider |
| `@codemirror/lang-markdown` | 6.3.2 | Markdown + GFM |
| `@codemirror/language-data` | 6.5.1 | Code-fence highlighting |
| `markdown-it` + plugins | 14.1.0 | Core renderer (task-lists, emoji, footnote + custom pagebreak rule) |
| `@mdit/plugin-{attrs,mark,ins,sub,sup,dl,abbr,figure,img-size}` | 0.23–0.25 | Batch 1: typography & semantic markup |
| `@mdit/plugin-alert` + `@mdit/plugin-katex` + `katex` | 0.23–0.25 / 0.16 | Batch 2: alerts + math |
| `markdown-it-anchor` + `markdown-it-toc-done-right` | 9.2.0 / 4.2.0 | Batch 3: heading IDs + `[[toc]]` |
| `mermaid` (CDN ESM, lazy) | 11.x | Batch 3: diagrams; pinned in `shared/utils/mermaidCdn.ts` |
| `highlight.js` | 11.11.1 | Code highlighting (CDN stylesheet) |
| `dompurify` | 3.2.4 | XSS sanitization |
| `pagedjs` (CDN) | 0.4.3 | CSS Paged Media polyfill; pinned in `shared/utils/pagedjsCdn.ts` |
| `nanoid` | 5.1.5 | ID generation |
| `@google/genai` | ^1.50 | Gemini SDK |
| `@google-cloud/speech` | ^7.3 | Cloud Speech-to-Text SDK (used with API-key auth, NOT a service account) |
| `file-type` | ^22 | Magic-byte sniffer for knowledge-upload content-type validation (confirm endpoint) |

### Sync server (`sync-server/`)

| Package | Version | Purpose |
|---|---|---|
| `@hocuspocus/server` | 3.4.4 | WS sync server |
| `y-postgresql` | 1.0.1 | Y.js persistence (⚠ `useIndex: false` — 1.0.1 has SQL bug) |
| `pg` | ^8.20 | Driver |
| `jsonwebtoken` | 9.0.2 | JWT verification |

### Nuxt server

| Package | Version | Purpose |
|---|---|---|
| `drizzle-orm` | 0.45.2 | Type-safe ORM (`node-postgres` adapter) |
| `drizzle-kit` | 0.31.10 | Migration generator |
| `pg` | ^8.20 | Driver |
| `@aws-sdk/client-s3` + presigner | 3.750.0 | Image uploads |
| `jsonwebtoken` | 9.0.2 | Hocuspocus token minting |
| `zod` | ^4 | Validates Gemini function-call args; `z.toJSONSchema` generates tool schemas |

> Password hashing uses `nuxt-auth-utils` built-in scrypt `hashPassword`/`verifyPassword` — not argon2.

---

## 3. Data Model

| Data | Storage |
|---|---|
| Users, documents (theme JSONB, `workspace_id`), shares, workspaces, workspace_members, uploads, activity, rate-limits, AI sessions | PostgreSQL (Drizzle) |
| Y.js document state | PostgreSQL (`yjs_documents` via `y-postgresql`) |
| Workspace knowledge (rows + markdown cache) | PostgreSQL (`workspace_knowledge`) |
| Knowledge chunks (content + 768-d vector + tsvector) | PostgreSQL (`workspace_knowledge_chunks`, pgvector HNSW + GIN) |
| Image blobs | S3 at `docs/{docId}/{fileId}.ext` |
| Knowledge originals (transient — deleted after successful processing) | S3 at `workspaces/{wsId}/knowledge/{kId}.{ext}` |
| Postgres backups | S3 at `backups/postgres/{ISO8601}.sql.gz` |
| User sessions | Sealed cookies (`nuxt-auth-utils`), versioned via `SESSION_VERSION` |

Schema source-of-truth: `server/db/schema.ts`. Enums as `text('col', { enum: [...] })` not `pgEnum` — adding values is TS-only, no `ALTER TYPE` friction.

**Migrations:** `bun run db:generate` diffs against `drizzle/meta/` snapshots. `server/plugins/00-db-migrate.ts` applies at boot (numeric prefix forces load-first). `server/plugins/99-shutdown.ts` closes pg pool. `NUXT_S3_ENDPOINT` swaps S3 backends with no code changes.

**Postgres image:** `pgvector/pgvector:pg16` (drop-in for `postgres:16-alpine`, data-dir compatible). Migration `0005_lame_cassandra_nova.sql` runs `CREATE EXTENSION IF NOT EXISTS vector` before the knowledge tables — drizzle doesn't emit CREATE EXTENSION, so it's hand-prepended in the generated file.

---

## 4. Auth & Access Control

### Access modes

| Mode | Anonymous | Logged-in non-owner | Owner |
|---|---|---|---|
| **Private** (default for logged-in docs) | forbidden | forbidden | Full control |
| **Open edit** (default for anonymous docs) | Edit | Edit | Full control |
| **Open view** | View | View | Edit + manage |
| **Password-protected** | Enter password | Enter password | Edit + manage |

Workspace membership overrides: admin/editor bypasses `private` and `password-protected`; viewer gets read-only access regardless of accessMode.

**Read-only: 4 layers** — (1) token mints JWT with `readOnly: true`, (2) Hocuspocus blocks Y.js updates, (3) CM6 Compartments set `EditorView.editable + EditorState.readOnly`, (4) UI hides toolbar.

**Password-protected: 3 layers** — (1) token returns `token: null`, (2) Hocuspocus rejects, (3) `v-if="!requiresPassword"` blocks editor mount.

**Session:** 7d maxAge. `SESSION_VERSION` in `server/utils/validatedSession.ts` invalidates stale cookies on next request. OAuth handlers in `server/routes/auth/` (NOT `server/auth/`).

### Workspaces & roles

`workspace_members` is the authorization source of truth — `workspaces.ownerId` is provenance only, never read for authz. Three roles:

| Action | Viewer | Editor | Admin | Doc owner |
|---|:-:|:-:|:-:|:-:|
| View doc | ✓ | ✓ | ✓ | ✓ |
| Edit content / title / theme | — | ✓ | ✓ | ✓ |
| Change access mode / password | — | — | ✓ | ✓ |
| Delete doc | — | own only | any | own |
| Create doc in workspace | — | ✓ | ✓ | n/a |
| Add / remove members, change roles | — | — | ✓ | n/a |
| Rename / delete workspace | — | — | ✓ | n/a |
| Leave workspace | ✓ | ✓ | ✓ (if not last admin) | n/a |

- **≥1 admin invariant** enforced in `workspace_members/[userId].patch.ts` and `.delete.ts` (409 on last-admin demotion/removal).
- **Invite: exact-email only.** 404 no-such-user, 409 duplicate. Default role = editor. No typeahead to avoid user enumeration.
- **Central helpers:** `server/utils/workspaceAccess.ts` — `getWorkspaceRole`, `getDocAuthz`, `canEditDoc`, `canManageDoc`, `canManageWorkspace`, `countWorkspaceAdmins`. Additive: standalone/anonymous doc flows unchanged.
- **Token endpoint** queries `workspace_members`: admin/editor → `readOnly: false`, bypasses `private`; viewer → `readOnly: true` always.
- **Cascade delete:** iterates all docs, calls `deleteDocument()` per-doc (S3 + Y.js + sync notify); `workspace_members` drop via FK cascade.
- **"Recent Documents"** dashboard lists only owned docs; workspace docs surface inside the workspace view.

---

## 5. API Routes

`server/api/` → `/api/*`. `server/routes/` → `/`. `server/auth/` is unreachable.

**Auth:** `GET /auth/github`, `GET /auth/google`, `GET /api/_auth/session`

**Meta:** `GET /api/health` (DB probe), `GET /api/version` (SPA staleness)

**Documents:** `POST /api/docs` (anon OK; accepts `workspaceId`), `GET/PUT /api/docs/:id/meta`, `DELETE /api/docs/:id` (`canManageDoc`), `GET /api/docs/:id/token` (consolidated: token + readOnly + requiresPassword + forbidden + accessMode + ownerId + workspaceId + workspaceRole), `GET /api/docs/:id/activity`, `POST /api/docs/:id/password`, `PATCH /api/docs/:id/workspace` (move; `canManageDoc` on source + admin/editor on target), `POST /api/docs/:id/duplicate` (clone row + Y.js state with URL rewrite + S3 assets; `canEditDoc` on source, new owner = duplicator)

**Internal (sync→app, `X-Internal-Secret`):** `POST /api/internal/activity`

**User:** `GET /api/user/documents`, `GET /api/user/workspaces`, `GET /api/user/recent`

**Files:** `POST /api/upload/request` (presigned PUT), `POST /api/upload/confirm`, `GET /api/files/:docId/:fileId` (302 → presigned GET, access-controlled)

**Import:** `POST /api/import` (DOCX/PDF/PPTX/XLSX/HTML/EPUB → markdown, 50MB, public)

**Workspaces (login required):** `POST /api/workspaces` (enforces per-user cap), `GET/PUT/DELETE /api/workspaces/:wsId`, `POST /api/workspaces/:wsId/members`, `PATCH/DELETE /api/workspaces/:wsId/members/:userId`

**Workspace knowledge (login required + membership):**
- `POST /api/workspaces/:wsId/knowledge/upload-request` — admin/editor; rate-limited + cap-checked; mints 300s presigned PUT + reserves Valkey inflight slot
- `POST /api/workspaces/:wsId/knowledge/confirm` — HEAD + `file-type` magic sniff + advisory-locked cap recheck + row insert; kicks `processKnowledge` fire-and-forget; always releases inflight slots
- `GET /api/workspaces/:wsId/knowledge` — any member; returns items (sans `markdown_cache`) + aggregate usage/cap info
- `DELETE /api/workspaces/:wsId/knowledge/:knowledgeId` — admin or editor-who-uploaded; cascades chunks via FK + best-effort S3 delete

**AI (login required):** `POST /api/ai/prompt` (returns `{sessionId}`; also handles selection-scoped rewrites since phase 5 collapsed the separate rewrite path into this one), `POST /api/ai/abort` (initiator only, 403 otherwise), `POST /api/ai/transcribe` (voice → text via Cloud STT sync; `{text, inaudible}`), `POST /api/ai/dictate/token` (mints 60s JWT for the dictation WS), `WS /api/ai/dictate` (live dictation relay — JWT auth via first message, NOT query string)

Auth guard: `server/middleware/auth.ts` whitelists public patterns; protects `/api/docs/` (outside whitelist), `/api/workspaces`, `/api/user`, `/api/upload`, `/api/ai`. Token endpoint never issues a usable JWT for forbidden/password-gated docs.

---

## 6. Sync Server (Hocuspocus)

Config at `sync-server/src/index.ts`. Hooks: `onLoadDocument`, `onStoreDocument`, `onAuthenticate`, `onConnect`/`onDisconnect`, `onRequest`.

- **Persistence:** `y-postgresql` singleton with `useIndex: false`, `flushSize: 200`. `onLoadDocument` returns `new Y.Doc()` on failure (never throws). `clearDocument` on deletion.
- **Auth:** `JWT_SECRET` required at startup. Every WS connection must present a valid JWT. Verifies `payload.docId === documentName`.
- **Rate limiter:** 20 connections/IP via `connectionIPs: Map<socketId, ip>` (not mutating connection object — Hocuspocus v3 hook shapes vary). Max 5000 rooms.
- **Activity logging:** Primary attribution from `lastEditorByDoc` Map (JWT `userName`). Fallback: `mostRecentEditorFromAwareness`. Fire-and-forget POST to `${APP_URL}/api/internal/activity` with 5s timeout. Dev: sync→app via `host.docker.internal`; **Nuxt dev must bind `0.0.0.0`.**
- **Internal HTTP** (`sync-server/src/internal-http.ts`, gated on `X-Internal-Secret`):
  - `GET /health` — public healthcheck for Traefik/Docker
  - `POST /internal/notify-deleted` — sets `ymeta._deleted` + `clearDocument()`
- **Graceful shutdown:** SIGTERM → `server.destroy()` → `ypgPersistence.destroy()`. 25s kill-timer. Compose `stop_grace_period: 30s`.
- **Running:** TS runs directly under Bun (no pre-bundle; bundler chokes on Hocuspocus CJS/ESM exports).

---

## 7. AI Features — Gemini + Cloud Speech-to-Text

Two Google vendors: **Gemini** (Generative Language API, via `@google/genai`) for all generative flows, **Google Cloud Speech-to-Text** (v1 via `@google-cloud/speech`) for all speech transcription. The keys are split on purpose — each is restricted per-API in GCP so a compromise of one doesn't pivot to the other. Read via `config.google.geminiApiKey` / `config.google.speechToTextApiKey`.

Three flows (phase 5 collapsed the separate inline-rewrite path into the unified agentic loop):
- **Agentic prompt** — one path serving both the bottom `AIPromptBar.vue` and the selection-scoped `AISelectionPopup.vue`. Full tool use, 9 tools + 2 knowledge tools (gated on workspace membership). Model: `NUXT_GOOGLE_MODEL` (default `gemini-3.1-flash-lite-preview`). Image generation uses `NUXT_GOOGLE_IMAGE_MODEL` (default `gemini-3.1-flash-image-preview`). Embeddings use `NUXT_GOOGLE_EMBEDDING_MODEL` (default `gemini-embedding-2-preview`, 768-d via `outputDimensionality` MRL). The selection popup pre-captures an `EditorSelectionSnapshot` (kind=`selection`) and passes it as `editorSelection` on `/api/ai/prompt`, so the model sees the range inside `<editor_state>` and picks `replace_text` accordingly.
- **Voice input for the prompt bar** (mic button inside `AIPromptBar.vue`) — one-shot transcription via Cloud STT sync `speech:recognize`. `MediaRecorder` + `AnalyserNode` visualiser in `useVoicePrompt.ts`, POSTs base64 audio + MIME + languageCode to `/api/ai/transcribe` → Cloud STT → plain text → auto-submits as a normal prompt. 60s cap, 5 MiB max. No Y.js session — transcription itself doesn't touch the doc; the downstream `/api/ai/prompt` call enforces all the usual content gates.
- **Live dictation into the editor** (mic button in the formatting toolbar) — streaming transcription via Cloud STT `streamingRecognize` over a Nitro WebSocket at `/api/ai/dictate`. Interim partials render as ghost text at the CM6 caret; finals commit into Y.js with a `dictation:{userId}` origin. Auth via short-lived JWT sent as the FIRST WS message (NOT `?token=`, which would leak into access logs). One session per user enforced via Valkey `SET NX EX` lock keyed on `lock:ai-dictate-active:{userId}`. Audio-seconds metered into a daily budget. See `useVoiceDictation.ts` + `dictationExtensions.ts` + `server/routes/api/ai/dictate.ts`.

**Thinking budget:** `NUXT_GOOGLE_THINKING_BUDGET` (default `0` = disabled, cheapest/fastest). Applied only to the main agentic loop. We only pass `thinkingConfig` when `budget > 0` — some models (older `flash-lite`) 400 on an empty thinkingConfig.

**AI-as-Y.js-client:** Server mints a JWT (`userId=ai:assistant:{sessionId}`), opens a `HocuspocusProvider`, sets awareness `{isAI, aiSession, aiStatus}`. Each edit is `ydoc.transact(fn, 'ai:assistant:{sessionId}')` — users watch edits land in real time. No SSE; status rides on awareness. The `AiSession` interface exposes `docId` and `initiatorUserId` so tools can attribute audited writes (e.g. `uploads.uploaderId` from `generate_image`) to the real human initiator rather than the synthetic AI principal.

**Function tools** (`server/utils/agentic/functionTools.ts` + `server/utils/aiToolAdapter.ts`):

| Tool | Behavior |
|---|---|
| `view_document({ view_range? })` | Returns `ytext.toString()` with 1-indexed line prefixes. Schema refines `start >= 1` so `[-1,-1]` is caught at Zod, not the handler. |
| `replace_text({ old_str, new_str })` | 0 matches → error; 2+ → "Found N matches"; 1 → transact delete+insert. |
| `insert_text({ insert_line, insert_text })` | Maps line → char idx via shared `lineToCharOffset`; transacts insert. |
| `update_theme({ preset?, page?, body?, … })` | Partial theme patch. `preset` (`modern`/`academic`/`tech`/`business`/`novel`/`newsletter`) replaces base; other fields merge on top. Validates via `isValidTheme`, writes `ymeta.theme` + persists to `documents.theme` JSONB. |
| `set_title({ title })` | Trim + 1–255 bound; writes `ymeta.title` + persists via `updateDocMeta`. |
| `view_image({ src })` | Fetches image bytes and smuggles them back to the model via `inlineData` on the next turn (Gemini functionResponse is JSON-only — see `ToolResult.extraParts` below). Internal `/api/files/{docId}/{fileId}` → S3 direct (with cross-doc rejection); external `http(s)://` → `fetch` with 10s timeout + 5 MiB cap + MIME allowlist. |
| `generate_image({ prompt, alt })` | Gemini image-model sub-call (`responseModalities: ['IMAGE','TEXT']`) → S3 upload (same `docs/{docId}/{fileId}.ext` key shape as user uploads) → uploads row (pending+confirmed) → returns markdown reference. AI follows up with `insert_text`/`replace_text` — the tool does not place it. |
| `web_search({ query })` | Isolated sub-call with `googleSearch` grounding only. Freeform answer text + deduped sources from `groundingMetadata` (never mixed with `functionDeclarations` or `responseSchema` — coexistence 400s across model versions). |
| `fetch_url({ url })` | Isolated sub-call with `urlContext` + structured output (`responseSchema`: `{summary, images[]}`). Returns formatted text the agent can parse. Scheme-less URLs get `https://` prepended. |
| `search_knowledge({ query, top_k? })` | Hybrid search over `workspace_knowledge_chunks` (vector cosine via HNSW + BM25 via `ts_rank_cd` on a stored tsvector) fused via Reciprocal Rank Fusion (`k=60`). Returns top-K with `semantic=…` + `lexical=…` score breakdown so the model can tell paraphrase hits from exact-phrase hits. Only exposed when the session has a workspaceId AND the workspace has at least one `status='ready'` file. See §8. |
| `get_knowledge_file({ knowledge_id })` | Returns the cached markdown of one knowledge file, truncated to 40k chars with an explicit marker. knowledge_ids come from the `<knowledge_files>` system-prompt block — fabrication is rejected with "not found, use only ids from the block". |

**Tool declarations are split:** `ALL_TOOL_DECLARATIONS` = the 9 always-on tools; `KNOWLEDGE_TOOL_DECLARATIONS` = the 2 workspace-gated tools. `server/api/ai/prompt.post.ts` concatenates them only when the session has workspace access AND at least one ready knowledge file, AND appends a `<knowledge_files>` block listing `{knowledge_id, filename, sizeBytes, sourceExt, tokenCount}` so the model can pick ids without guessing. `AiSession.workspaceId` is set at session-open so tool handlers can double-check scope.

**`ToolResult.extraParts`:** tools whose output includes binary data (currently `view_image` with inline image bytes) return a `ToolResult` with an `extraParts: Part[]` field; the runLoop appends those sibling parts on the user message AFTER the `functionResponse`, so Gemini links them to the right call. Gemini's `functionResponse.response` is JSON-only — this is the smuggling path for anything non-JSON.

**Source-of-truth for schemas:** Zod drives everything. `z.toJSONSchema(schema, { target: 'draft-7' })` generates both Gemini's param schema and the runtime validator. Schema-level rejections flow back via `functionResponse.isError` so the model self-corrects instead of us silently coercing garbage. Drift-prone strings in the system prompt (preset names, font-category hints) are derived at module load from `THEME_PRESETS` / `THEME_FONTS`, so adding a preset/font automatically propagates.

**Authorization:** All AI routes check `requireDocEditAccess(docId, userId)` before starting. Workspace viewers and non-members are blocked there, so every tool inherits "content-edit" permission — no per-tool authz check needed. `update_theme`/`set_title` write through the same gate.

**Limits:** `ai-prompt: 20/h` per user. Prompt deadline 5 min, `MAX_TURNS = 20`. Sweeper (`server/plugins/ai-session-sweep.ts`) aborts sessions >7 min (threshold intentionally above prompt deadline). Error status lingers 2.5s in awareness so clients latch before cleanup.

**Cancellation:** `POST /api/ai/abort` — 404 if ended, 403 if not initiator. Status → `{phase:'done', message:'Stopped'}`.

**Per-user cap:** 1 session per user per doc, enforced by Postgres UNIQUE index in `ai_sessions`.

**Frontend status display:** `describeToolInput` in `streamStatus.ts` has a labelled case for every tool (announced via awareness). `AIPromptBar.vue` shows the message as the input placeholder; `PresenceBar.vue` appends the status to the avatar tooltip (`"Helping Joel — Fetching example.com"`) so collaborators can see what someone else's AI run is doing.

### Live dictation stack

**Transport:** Nitro native WebSockets (`nitro.experimental.websocket: true`). Single WS route: `server/routes/api/ai/dictate.ts` implements `{ websocket: { upgrade, open, message, close, error } }` hooks. An HTTP fallback on the same path 426s so a stray GET/POST gets a useful error. `defineEventHandler({ websocket: ... })` also needs the `experimental.websocket: true` flag or Nitro silently ignores the hooks.

**Protocol** (sym docs live in the handler's head comment):
- Server → client: `{type:'hello'}` on open → `{type:'ready'}` after auth + STT up → `{type:'partial', text}` / `{type:'final', text}` → terminal frames `budget-exhausted` / `session-cap` / `idle-timeout` / `error`.
- Client → server: `{type:'auth', token, languageCode?}` as the FIRST message (no `?token=` in the URL — avoids access-log leakage) → binary PCM chunks → `{type:'stop'}` for graceful finalize.

**Text-vs-binary detection:** crossws + the Node `ws` library deliver TEXT frames as Buffer, so `typeof rawData === 'string'` never matches. `tryParseControl` in `server/utils/agentic/dictateHelpers.ts` peeks the first byte for `{` (0x7B) before attempting a `JSON.parse` + whitelist the `type` field — audio chunks that coincidentally start with `{` don't get routed as control frames.

**Auth lifecycle:** `POST /api/ai/dictate/token` mints a 60s JWT with `{userId, docId, kind: 'dictate'}` signed with `config.google.dictateJwtSecret` (falls back to `config.jwtSecret` for dev). Middleware whitelists `/api/ai/dictate` because the WS upgrade hook gets a raw Request (not an H3Event), so reading the sealed session cookie there isn't practical. The WS `open` hook arms a 5s auth-deadline timer that closes the socket if no valid `{type:'auth'}` arrives in time.

**Concurrent-session cap:** `tryAcquireSessionLock('ai-dictate-active', userId, SESSION_HARD_CAP_MS)` in `server/utils/rateLimit.ts`. Valkey `SET NX PX` — one dictation session per user across ALL Nitro workers / containers (an in-memory Set would silently fail across workers behind Traefik). TTL matches the session hard cap so a crashed worker's lock self-expires. Released via `releaseSessionLock` on every WS close/error hook. Fails **closed** on Valkey errors (correctness lock, not a rate limit — failing open would double-bill GCP).

**Audio-seconds budget:** `consumeRateLimitBudget('ai-dictate-ms', userId, CHUNK_AUDIO_MS, DAILY_BUDGET_MS, DAILY_WINDOW_MS)` — 30 min/user/day counted in ms, not requests. Each AudioWorklet chunk (2048 samples @ 16 kHz = 128 ms) debits 128. Peek mode (`cost: 0`) returns the REAL remaining (`maxCost - current`), not a naive `maxCost` — the session-open check would otherwise always pass for exhausted users and only trip on the first chunk (open-then-close flicker).

**Client state machine** (`useVoiceDictation.ts`): `idle → requesting-permission → connecting → recording → idle/error`. VueUse primitives: `useUserMedia` for stream lifecycle (explicit `track.stop()` on unmount so the mic indicator clears), `useWebSocket` with `immediate: false` AND `autoConnect: false` — default `autoConnect:true` watches the URL ref and opens a socket on change, racing an explicit `.open()` call and spawning TWO connections per click. Audio pipeline: `AudioContext({ sampleRate: 16000 })` → `MediaStreamAudioSource` → `AudioWorkletNode` loading `/public/worklets/pcm-recorder.js` → 2048-sample Int16 chunks → WS binary send.

**CM6 integration** (`app/utils/dictationExtensions.ts`): a `StateField<string>` holds the current interim text, dispatched via `setDictationInterim.of(text)` from the composable. A `ViewPlugin` rebuilds a `Decoration.widget` at the caret whenever the state field, doc, or selection changes — so the ghost text reflects caret moves (the "click elsewhere and keep dictating" UX). `commitDictationFinal` inserts finalized phrases via `ydoc.transact(fn, 'dictation:{userId}')` with smart spacing: a leading space is inserted if the caret is inside a word (`fo|o` + "bar" → `fo bar o`), same for trailing. Wrapped in a yCollab-ready ydoc transaction so collaborators see the commit land.

**Straggler-chunk guard:** `stt.end()` on `{type:'stop'}` sets `ctx.sttEnded = true`. Audio chunks still in the browser's worklet → postMessage queue between "user clicked stop" and "composable disconnected" (~128 ms window) land at the WS post-end; the flag drops them before they hit `stt.write()`, which would otherwise throw "write after end" and surface as a UI error toast. A second defense: the SpeechClient's error listener recognizes `"write after end"` when `sttEnded` is true and silently swallows it.

**Mock for tests:** `createDictateSpeechClient(apiKey)` in `dictateSpeechClient.ts` returns a real SpeechClient or, when `TEST_MODE=1` + `NUXT_GOOGLE_SPEECH_MOCK=1`, a fake that emits canned interim → final responses on fixed chunk thresholds. Lets integration tests drive the full dictation state machine without hitting Google or paying per-minute.

---

## 8. Workspace Knowledge Base

Workspace-scoped file uploads that the AI can retrieve from. Lives under `/w/:id` (and embedded in the editor's right sidebar via the library icon next to Activity + Theme). Files flow: presigned S3 PUT → markitdown parse → heading-aware chunker → Gemini per-chunk embedding → pgvector row. Retrieval: hybrid RRF over vector + BM25.

### Data

- **`workspace_knowledge`** — one row per uploaded file. Statuses: `processing` → `ready` / `failed`. Columns of note: `markdown_cache` (parsed output, served to `get_knowledge_file`), `embedding_version` (`model:dims`, so future model bumps can detect stale rows), `chunk_count`/`token_count` (audit + surfacing), `s3_key` (original file, deleted after successful processing — see below).
- **`workspace_knowledge_chunks`** — per-chunk. `embedding vector(768)` + HNSW cosine index + STORED generated `content_tsv tsvector` + GIN index. `workspace_id` is denormalised so the search query doesn't need the parent-table join.

### Upload pipeline

Two-phase presign (same pattern as image uploads):

1. `POST /api/workspaces/:wsId/knowledge/upload-request` — `requireKnowledgeEditAccess` (admin/editor) + rate-limit (30/min/user) + `reserveUploadSlot` (checks per-workspace + per-user caps, reserves Valkey inflight slots) → mints a 300s `ContentType`-bound presigned PUT URL. No DB row yet.
2. Client PUTs bytes directly to S3.
3. `POST /api/workspaces/:wsId/knowledge/confirm` — HEADs the object, magic-byte sniff via `file-type` (see below), advisory lock (`pg_advisory_xact_lock(hashtext(wsId))`) + cap recheck + filename disambiguation + row insert in ONE transaction, releases inflight slots in `finally`, then `void processKnowledge(id)` fire-and-forget.

### `processKnowledge` (server/utils/processKnowledge.ts)

Sequential: fetch S3 bytes → POST to markitdown (`markitdown-server` FastAPI at `$NUXT_MARKITDOWN_URL`) with `?ext=…` → chunk the returned markdown (heading + paragraph aware, `maxChunks` cap from config — sentinel truncation chunk on overflow) → embed each chunk with `RETRIEVAL_DOCUMENT` task-type → `DELETE FROM chunks WHERE knowledge_id = :id` then bulk `INSERT` new chunks → flip status to `ready` + populate `markdown_cache` → delete the original S3 object (we never serve it back; `markdown_cache` + chunks are enough). Errors flip the row to `failed` with a truncated `error_message`. Row-existence re-checked after conversion AND after embedding so a user deletion mid-pipeline aborts cleanly without wasting embedding round-trips.

### Embeddings (server/utils/embeddings.ts)

Gemini's JS SDK `embedContent` with `contents: [str, str, …]` returns ONE aggregate embedding for the combined content — NOT one per string like the Python SDK. We loop per-chunk with a bounded `CONCURRENCY = 5` pool. Model + dims live in `config.google.embeddingModel` / `embeddingDims`; `embeddingVersionTag` (`model:dims`) is persisted with every row for future re-embed detection. `RETRIEVAL_DOCUMENT` task-type on ingest, `RETRIEVAL_QUERY` on search — Gemini's hints measurably improve recall over treating both the same.

### Hybrid search (server/repos/knowledge.ts)

Two queries fire in parallel (`candidatePool = 4 × topK` each):

- Vector: `1 - cosineDistance(embedding, :q)` via pgvector, `ORDER BY similarity DESC`.
- Lexical: `ts_rank_cd(content_tsv, websearch_to_tsquery('english', :qtext))` with `@@` predicate, `ORDER BY score DESC`.

Results are merged by `(knowledgeId, chunkIndex)` and ranked via **Reciprocal Rank Fusion** (`sum over sources of 1/(60 + rank)`). Chunks in both sources get a double contribution; chunks in one still place reasonably. Output carries both scores so the AI can see a "paraphrase hit" vs "exact-phrase hit" distinction. `websearch_to_tsquery` is forgiving (free-form input, quoted phrases, negation) — empty tsquery on all-stopwords returns zero lexical rows and the fusion quietly degrades to vector-only.

### Abuse limits

Defense-in-depth with three layers that each close a different hole:

| Layer | Check | Where |
|---|---|---|
| Rate limit | 30 upload-requests / user / min | `checkRateLimit('knowledge-upload', …)` in upload-request |
| Per-workspace caps | 500 files + 1 GB | DB count/sum at upload-request + confirm |
| Per-user caps | 100 files + 2 GB across ALL workspaces | DB count/sum at upload-request + confirm |
| Workspace-per-user cap | 20 owned workspaces | `countOwnedWorkspacesByUser` in `POST /api/workspaces` |
| Concurrent races | Valkey inflight counters (`knowledge-upload-ws` + `knowledge-upload-user`), 6 min TTL | `reserveInflightSlot` / `releaseInflightSlot` (fail CLOSED) |
| Confirm race | Postgres advisory lock `pg_advisory_xact_lock(hashtext(wsId))` inside a txn | confirm endpoint |
| Content-type bypass | Magic-byte sniff via `file-type` on first 4 KB of S3 object | `server/utils/fileTypeGuard.ts`, called in confirm |
| Chunk-count abuse | `maxChunksPerFile = 300` sentinel-truncation | `chunkMarkdown` in `processKnowledge` |
| Abandoned `failed` rows | TTL sweep: `status='failed'` rows older than `failedRetentionDays = 7` auto-reaped | `server/plugins/knowledge-sweep.ts` |
| Stuck `processing` rows | TTL sweep: `status='processing'` rows older than 10 min re-process | same plugin |

All caps live in `config.knowledge.*`; workspaces-per-user in `config.workspaces.maxPerUser`. The inflight counter fails CLOSED (correctness cap); the rate limit fails OPEN (DoS protection, not a cost cap). The advisory lock is load-bearing: without it, two concurrent confirms that both read N-1 used at upload-request time would both commit and land at N+1.

### Content-type validation

`file-type` sniffs the first 4 KB fetched via S3 Range GET (`bytes=0-4095` — enough for file-type's internal readers, including the ZIP-inside-ZIP inspection for Office formats). Allowlist per ext: PDF → `application/pdf`; DOCX/PPTX/XLSX → the specific Office MIME (file-type differentiates by reading `[Content_Types].xml`); XLS → `application/vnd.ms-excel` OR `application/x-cfb` (legacy CFB). Text formats (MD/TXT/HTML/HTM) have no reliable magic — we instead decode as strict UTF-8 and check ≥90% printable chars on the first 1 KB. Mismatch → 415 + orphan S3 delete + slot release.

### AI integration

The two knowledge tools (`search_knowledge`, `get_knowledge_file`) are in `KNOWLEDGE_TOOL_DECLARATIONS`, separate from `ALL_TOOL_DECLARATIONS`, and are ONLY passed to `runAgenticLoop` when both: (a) session has `workspaceId` AND (b) workspace has ≥1 ready file. The system prompt also appends a `<knowledge_files>` block listing `{knowledge_id, filename, sizeBytes, ext, tokenCount}` so the model has ground-truth file identities — we explicitly reject fabricated knowledge_ids. `AiSession.workspaceId` flows from `/api/ai/prompt` resolution → `createAiSession` → tool handlers, which double-check scope as defense in depth.

### UI

`WorkspaceKnowledgePanel.vue` drives upload + list + delete with XHR progress tracking and 5s-interval status polling (auto-stops when no items are `processing`). Mounted in two places: the workspace overview (`app/pages/w/[id].vue`) with the full header, and the editor's right sidebar (`EditorLayout.vue`) with `compact` prop to drop the duplicate heading. The sidebar button (library icon) only appears when `docWorkspaceId` is set AND the viewer is a member. Delete uses `WorkspaceKnowledgeDeleteConfirmModal.vue` (simple yes/no — no "type the name" required, since knowledge is an upload artifact not user-authored content).

---

## 9. Document Composables

Three-file split (`app/composables/`):
- **`useDocToken.ts`** — fetches `/api/docs/:docId/token`; seeds initial theme; handles password-verify reconnect. Exposes: `token, readOnly, requiresPassword, forbidden, accessMode, isOwner, hasOwner, initialTheme, pendingPasswordUnlock, setAccessMode`.
- **`useHocuspocusSync.ts`** — provider lifecycle only. `getToken()` callback for reconnects. Exposes: `provider, status, synced, userCount, docSizeBytes, reconnect`.
- **`useDocument.ts`** — thin orchestrator. Creates Y.Doc + awareness + undoManager, composes the workers, owns title bridge (`ymeta.observe` → Vue ref), deletion observer (`ymeta._deleted`), welcome-doc seeding.

Key invariants: single consolidated fetch on init (token endpoint returns metadata + theme — no separate `/meta` call); single Awareness instance passed to both provider and yCollab; title/theme bridged via `ymeta.observe()`; `requiresPassword` flips false only on `onSynced` to prevent empty-doc-prepend bug.

`canEditTheme` mirrors content edit access: read-only = false, owner = true, anonymous on ownerless doc = true.

---

## 10. Preview Rendering & PDF Export

Right pane shows discrete A4/Letter pages inside a same-origin srcdoc iframe. PDF uses the same pipeline in a hidden iframe + `window.print()`. No server Chromium.

**Pipeline (`app/utils/renderMarkdown.ts` → `shared/utils/themeToCss.ts` → `app/composables/usePagedPreview.ts`):**
1. `renderMarkdown.ts` — singleton markdown-it + DOMPurify. Plugins lazy-imported inside `init()`. Pipeline: core + task-lists + emoji + footnote + Batches 1–3 + custom pagebreak rule. Always emits `language-${lang}` class so the mermaid detector finds `pre code.language-mermaid`.
2. `transformFootnotesForPagedMedia(html)` lifts footnote `<li>` from end-of-doc `<section>` to inline `<span class="footnote">` at the ref site — required for paged.js `float: footnote`.
3. `themeToCss.ts` compiles `DocTheme` into the full stylesheet — `@page`, margin boxes, `.paged-doc` body, headings, TOC (with `target-counter` page numbers), page-break, column-span spanners.
4. `usePagedPreview.ts` mounts a persistent srcdoc iframe. Parent calls `iframe.contentWindow.__renderDoc(opts)` (250ms debounce). Iframe decodes images, pre-processes mermaid → SVG, then runs paged.js. Posts back `{type:'paginated', pageCount}`. Fragment links intercepted to prevent srcdoc iframe navigation.
5. `printPdf.ts` — hidden iframe, `window.PagedConfig = { auto: true, after: () => print() }`, 30s timeout. Mermaid pre-processed in parent context (different window = different module instance).

**Why iframe:** paged.js mutates global head styles + `:root` vars and re-paginates on every call. Running on the host page caused unrecoverable layout contamination. Use CSS `zoom` (not `transform: scale`) for responsive shrinking — zoom shrinks layout box; scale doesn't.

**paged.js quirks:** Polisher only processes `@page` rules from `stylesheets` argument — pass `[{ 'theme.css': cssText }]`. Margin boxes are siblings of `.paged-doc`, not descendants; CSS custom properties don't propagate up. Bake `{title}`/`{date}` into the CSS string directly.

**Theme system (`shared/types/theme.ts:DocTheme`):** Per-doc JSONB in `documents.theme`, mirrored to `ymeta.theme`. Validated by `shared/utils/themeValidation.ts`. Editor panel: `ThemeEditorPanel.vue` (11 accordion sections). Presets in `shared/utils/themePresets.ts` (Modern, Academic Paper 2-col, Tech Report, Business Report, Novel, Newsletter). Font picker from `shared/utils/themeFonts.ts` (20 fonts). Header/footer tokens: `{title}`, `{date}`, `{page}`, `{pages}` — inserted at cursor via `data-slot`/`data-position`. Phase 4 (user-saved themes) still pending.

---

## 11. Mobile

Breakpoint: `useMediaQuery('(max-width: 639px)')` — matches Tailwind `sm:`. Don't reintroduce 768px.

- Edit-only default on narrow; `watchEffect` forces `viewMode = 'edit'` when `isMobile && viewMode === 'split'`.
- CM6 responsive theme via Compartment: 16px font (prevents iOS auto-zoom), 1.7 line-height, reconfigured on resize.
- `autocapitalize: 'sentences'`, `autocorrect: 'on'`, `spellcheck: 'true'` always on.
- Toolbar `flex-wrap`, collapsed hamburger menu, icon-only connection badge, responsive title.
- Right sidebar: `< xl` (≤1279px) — opening panel hides preview; `xl+` — fixed `w-80` sidebar, genuine triple-pane. Preview uses `hidden xl:block` (CSS), not `v-if`, so resize past xl restores it without remounting.

---

## 12. Security

**Authentication:** OAuth via `nuxt-auth-utils` (HTTP-only cookies, CSRF-protected). `SESSION_VERSION` invalidation. Hocuspocus always requires valid JWT. `JWT_SECRET`, `DATABASE_URL`, `INTERNAL_API_SECRET` fail-fast on missing.

**Rate limits:**

| What | Limit |
|---|---|
| Password brute-force | 5 per IP+docId/min |
| Token endpoint | 30 per IP/min |
| Import | 10 per IP/min |
| AI prompt | 20 per user/hour |
| AI transcribe | 60 per user/hour |
| Live dictation | 1 session/user (Valkey `SET NX`), 30 min/user/day audio, 10 min/session, 30s idle |
| Hocuspocus | 20 connections/IP, 5000 rooms |
| Knowledge upload | 30 presign-requests/user/min |
| Knowledge — per workspace | 500 files, 1 GB total, 25 MB per file |
| Knowledge — per user | 100 files, 2 GB total (across all workspaces) |
| Knowledge — per file processing | 300-chunk ceiling (sentinel-truncated) |
| Workspaces per user | 20 owned (invited workspaces don't count) |

**Input validation:** `meta.put` validates title (≤255), accessMode (enum), wordCount (0–10M), sizeBytes (0–100M), theme (structural + numeric ranges + hex-color regex + font allowlist). Image uploads: PNG/JPEG/GIF/WebP/SVG, 10MB. Imports: extension whitelist, 50MB. Knowledge uploads: extension allowlist (pdf/docx/pptx/xlsx/xls/html/htm/epub/md/txt) + magic-byte sniff at confirm (rejects `foo.pdf` holding EXE bytes).

**File access:** `/api/files/:docId/:fileId` checks access mode before presigning. Presigned URL TTL: 5min upload, 120s read (can't be revoked; short to survive access-mode/password/deletion changes). **Knowledge originals are never served back** — they're deleted from S3 after successful processing; only `markdown_cache` + embedded chunks remain, accessible only to workspace members via the AI tools.

**S3 bucket policy (prod deployment requirement):** the production S3 bucket MUST deny public `ListBucket`. Our code never issues a presigned GET for knowledge keys, but if the bucket is list-enabled an attacker who guesses one `workspaces/{wsId}/knowledge/` prefix could enumerate knowledge objects by key (keys include a 12-char nanoid = ~70 bits, still not worth relying on). Infomaniak defaults buckets to private; verify with `aws s3api get-bucket-acl --bucket $BUCKET` post-deploy. Dev is fine — `seaweedfs/s3.json` defines a single `ypad` identity with credentials and no anonymous identity, so unauthenticated bucket access is denied by default.

**Mid-session membership drift:** `/api/ai/prompt` resolves `session.workspaceId` once at session open. Knowledge tool handlers (`search_knowledge`, `get_knowledge_file`) re-check `getMemberRole(workspaceId, initiatorUserId)` on every invocation via `verifyWorkspaceMembership()` so an admin demotion mid-session immediately revokes further knowledge access at the next tool call. Viewers keep read access (same semantics as the REST list endpoint); only "no membership at all" is rejected. Documents themselves (`replace_text`/`insert_text`) still rely on the Hocuspocus JWT expiring for revocation — that's an accepted tradeoff (≤1 h), documented separately in this section.

**Confirm-endpoint input binding:** the knowledge-confirm handler requires `knowledgeId` to match the last path segment of `s3Key` (`/{knowledgeId}.{ext}`). Closes the "mint a presign for key A but claim it under knowledgeId B" surface — a confused/crafted client can't decouple the two server-minted values even though both round-trip through the client body.

**Other:** scrypt password hashing, 2h password token expiry, `html: false` + DOMPurify for XSS.

---

## 13. Docker Compose

| File | Scope | TLS | Use |
|---|---|---|---|
| `docker-compose.dev.yml` | Infra only (postgres, valkey, seaweedfs, sync, markitdown, backup) — Nuxt on host | — | Daily dev with HMR |
| `docker-compose.local.yml` | Full stack incl. Traefik + GlitchTip | mkcert on `ypad.127.0.0.1.nip.io` | Pre-push full-stack verification |
| `docker-compose.prod.yml` | Full stack incl. Traefik + GlitchTip | Let's Encrypt | VPS deploy |

Three standalone files — no shared base (plus `docker-compose.test.yml` for the integration suite). Dev: `bun run dev --host 0.0.0.0` (0.0.0.0 so sync container can reach via `host.docker.internal`). Ports: Postgres 5432, Valkey 6379, SeaweedFS 8333, Hocuspocus 4001, markitdown 8080. **Postgres image** is `pgvector/pgvector:pg16` across dev / local / test / prod — drop-in replacement for `postgres:16-alpine` with the `vector` extension pre-built.

Prod key points: postgres healthcheck gates `app` + `sync` startup; `stop_grace_period: 30s`; Traefik healthcheck labels on `/api/health` + `/health`; backup sidecar pipes `pg_dump | gzip | aws s3 cp`; Dockerfile **must `COPY drizzle/`** into runtime image.

Required env: `DOMAIN`, `ACME_EMAIL`, `SESSION_PASSWORD` (≥32), `GITHUB/GOOGLE_CLIENT_*`, `POSTGRES_PASSWORD`, `S3_*`, `JWT_SECRET` (≥64), `INTERNAL_API_SECRET`, `GOOGLE_GEMINI_API_KEY`, `GOOGLE_SPEECH_TO_TEXT_API_KEY`, `GOOGLE_MODEL/IMAGE_MODEL/SPEECH_MODEL`, `BACKUP_*`. Optional AI tuning: `NUXT_GOOGLE_THINKING_BUDGET` (default `0`), `NUXT_GOOGLE_DICTATE_JWT_SECRET` (recommended in prod — falls back to `JWT_SECRET` for dev so a compromised Hocuspocus secret doesn't also forge dictation tokens). Testing: `NUXT_GOOGLE_SPEECH_MOCK=1` (requires `TEST_MODE=1`) swaps the Cloud STT client for a canned fake.

---

## 14. Project Structure

`app/` — Vue frontend: `components/{auth,editor,preview,collab,ai,sharing,document,workspace,common}/` (workspace incl. `WorkspaceKnowledgePanel.vue` + `WorkspaceKnowledgeDeleteConfirmModal.vue`), `composables/`, `pages/` (index, `d/[id]`, `w/[id]`), `utils/` (renderMarkdown, printPdf, editorCommands, download, welcomeDoc).

`server/` — Nitro API: `routes/auth/` (OAuth), `routes/api/ai/dictate.ts` (live dictation WS handler; lives in `routes/` because native WS routes need the full path there), `api/` (docs, upload, files, import, internal, ai, user, workspaces incl. `workspaces/[wsId]/knowledge/{upload-request,confirm,index.get,[knowledgeId].delete}.ts`), `db/schema.ts`, `middleware/auth.ts`, `plugins/` (00-db-migrate, 99-shutdown, orphan-cleanup, ai-session-sweep, inactive-doc-sweep, knowledge-sweep), `utils/` (workspaceAccess, documentAccess, documentLifecycle, aiSessions, aiClient, aiToolAdapter, rateLimit, embeddings, chunkMarkdown, processKnowledge, knowledgeQuota, knowledgeAccess, fileTypeGuard, agentic/ — including dictateHelpers, transcribeHelpers, dictateSpeechClient), `repos/` (documents, uploads, workspaces, workspaceMembers, knowledge).

`sync-server/src/` — Hocuspocus: index, persistence, auth, rate-limiter, activity-logger, internal-http.

`shared/` — Cross-cutting: `types/` (theme, auth, pagedjs), `utils/` (themeToCss, themeValidation, themePresets, themeFonts, defaultTheme, CDN version pins).

`drizzle/` — generated migrations + meta snapshots (committed). `i18n/locales/` — en/de/fr/es/ja/zh JSON. `docs/` — DEPLOY.md, LOCAL.md, S3-SETUP.md, OBSERVABILITY.md, SECRETS-ROTATION.md.

`scripts/` — standalone Bun scripts for offline verification. `audit-markdown-pipeline.mjs` runs the full markdown-it + every plugin + DOMPurify chain (identical config to `app/utils/renderMarkdown.ts`) and prints raw + sanitized output per case. Run before adding a syntax claim to `server/utils/agentic/markdownReference.ts` — only document what the script confirms renders. See §19 for why this matters. `flows-ephemeral.ts` orchestrates the flow-test ephemeral stack (see §14b). `build-flows.ts` publishes Playwright flow output from `tests/e2e/output/flows/` to `public/flows/`.

`tests/e2e/` — Playwright flow tests. `fixtures/flow.ts` is the central fixture (cursor injection, manifest writing, content-hash dedup, EditorPage nested fixture, color-mode pre-seed). `page-objects/Editor.ts` is the page-object that flow tests query through. `flows/` holds the actual `*.spec.ts` flow tests. See §14b.

`content/docs/` + `app/layouts/docs.vue` + `app/pages/docs/` + `app/components/content/{Flow,FlowFrame}.vue` — the docs site that consumes the flows. See §14b for the full pipeline.

---

## 14b. Flow Docs System

End-to-end pipeline that turns Playwright tests into a documentation site. Each flow IS a test (asserts real product behaviour) AND a tutorial (renders as a slideshow with subtitles, browser chrome, animated cursor, pulsating highlight callouts). The same artefacts power both.

### Pipeline at a glance

```
tests/e2e/flows/<slug>.spec.ts           ← Playwright test using `flow` + `editor` fixtures
        │
        ▼  bun run flows:test  (or flows:test:ephemeral)
        │
tests/e2e/output/flows/<slug>/<locale>/<variant>/
  ├─ manifest.json        ← entry list (heading/narrate/shot), per-shot cursor + path + highlights
  └─ NN.png               ← screenshots, deduped by content hash
        │
        ▼  bun run flows:build
        │
public/flows/<slug>/<locale>/<variant>/  ← same shape, published statically
        │
        ▼  via $fetch in <Flow> at SSR time
        │
content/docs/.../page.md  ::flow{id="<slug>" mode="slides"}::
        │
        ▼  rendered by app/pages/docs/[...slug].vue
        │
docs site
```

### The fixture API (`tests/e2e/fixtures/flow.ts`)

A flow test pulls in `flow` (the recorder) and `editor` (the page-object + setup helpers):

```ts
test('Quick share', async ({ flow, editor }) => {
  await editor.recordPreamble()           // 2 captured shots: open homepage → click New Document
  await flow.heading('Name your document', 3)
  await flow.narrate('...')
  await flow.click('Click the title to rename', editor.page.titleButton)
  await flow.step('Type and Enter', () => editor.page.commitTitleEdit('My doc'))
  await flow.shot('Highlights demo', { highlights: [{label: 'Word count', selector: '...'}] })
})
```

- **`flow.step(caption, action, opts?)`** — runs `action`, then captures. Right when the action target IS the screenshot target (typing into a focused input).
- **`flow.click(caption, locator, opts?)`** — `locator.hover()` → screenshot (cursor visibly on target) → `locator.click()`. Right for click-then-navigate steps where capturing AFTER the click would land on the destination page with a stale cursor (see §19 SPA-cursor gotcha).
- **`flow.hover(caption, locator, opts?)`** — same as click but without the trailing click.
- **`flow.shot(caption, opts?)`** — screenshot WITHOUT an action.
- **`flow.narrate(text)`** — prose between shots.
- **`flow.heading(text, level?)`** — section break (## or ###).
- **`flow.skipNext()`** — suppress the next auto-screenshot (transient mid-fade states).
- **`opts.highlights: [{ label, selector }, ...]`** — pulsating orange callouts on a shot. Selector is resolved to a bounding box AT screenshot time. Strict mode (`FLOW_STRICT=1` or `CI=true`) fails when a selector resolves to nothing; local dev keeps a soft warning.
- **`editor.recordPreamble()`** — lean two-step preamble (open → click) for flows where doc creation IS the story. After capture, silently switches to split view.
- **`editor.silentSetup()`** — same setup, but writes nothing to the manifest. For flows where the editor is just setup (rich content, sharing, etc.).
- **`editor.page`** — `EditorPage` instance with stable selectors (`titleButton`, `viewMode.{edit,split,preview}`, `statusBar.{wordCount,syncStatus}`, `accessLockButton`, `sidebar.*`) and composite helpers (`waitForReady`, `switchToSplitView`, `startTitleEdit`, `commitTitleEdit`, `createNewDoc`).

### Captioning rules (read these before writing a flow)

Flows are documentation for end users, not implementation logs. Mistakes here erode trust faster than UI bugs.

- **User voice only.** No "Hocuspocus", no "the editor mounts", no "the read-only flag resolves". The user doesn't know what those mean.
- **Cut steps that don't move the user toward their job.** "Switch to split view" only matters if THIS flow is teaching split view. Otherwise it's setup, not a step.
- **End every flow at a tangible outcome.** A copied link. A PDF on disk. A password-gated URL. Not "the editor is in split view".
- **Each flow IS a test.** Every step has an assertion behind it (`commitTitleEdit` asserts the saved title is visible; clipboard reads are asserted against the actual URL). If a flow's assertions break, sharing/exporting/etc. is broken — even if the screenshots still look fine.

### Manifest shape

Per-locale + per-variant; one manifest per `(slug, locale, variant)` triple:

```json
{
  "version": 1,
  "title": "Quick share",
  "slug": "quick-share",
  "locale": "en",
  "variant": "light",
  "viewport": { "w": 1280, "h": 800 },
  "entries": [
    { "kind": "heading", "level": 2, "text": "Name your document" },
    { "kind": "narrate", "text": "Documents start untitled..." },
    {
      "kind": "shot",
      "file": "01.png",
      "caption": "Click the placeholder title to rename it",
      "cursor": { "x": 129, "y": 24 },
      "path": "/d/abc",
      "highlights": [{ "label": "Word count", "x": 16, "y": 760, "w": 80, "h": 18 }]
    }
  ]
}
```

### Capture semantics

- **Cursor injection** (`addInitScript`): tracks `mousemove`/`pointermove` AND the URL pathname at the time of motion. `readCursor` returns null when the path has changed since the last motion (SPA-nav staleness — see §19). Renders as a 32px orange-glowing SVG that smoothly transitions between slides via `transition: left, top` (Vue keeps the same element across slide changes).
- **Path** captured via `new URL(page.url()).pathname` per shot. Powers the fake browser-chrome address bar in `<FlowFrame>` (`ypad.app /d/abc123`).
- **Highlights**: each ref is resolved via `page.locator(sel).first().boundingBox()`. Renders as a pulsating orange box-shadow (no border) so it reads as "annotation" not "UI element".
- **Variant** comes from `testInfo.project.metadata.variant`. The fixture pre-seeds `nuxt-color-mode` localStorage via `addInitScript` in addition to project-level `colorScheme`, so the app renders the correct theme regardless of @nuxtjs/color-mode's resolution order.
- **Content-hash dedup**: each screenshot's bytes are SHA-256'd. If they match a previous shot in the same run, the new file isn't written and the manifest entry points at the existing PNG. Multiple manifest entries can share one PNG (e.g. highlight-only updates).
- **Nuxt devtools chrome stripped** via fixture-side CSS injection (`#nuxt-devtools-container { display: none !important }`) so the floating "Nuxt" badge doesn't end up in screenshots.

### Playwright projects (`playwright.config.ts`)

One project per `(locale, variant)` pair. Currently `en-light` + `en-dark`. Each project sets `colorScheme`, viewport (1280×800 — see §19 viewport gotcha), and `metadata: { locale, variant }` for the fixture to read. Adding a locale = duplicate both blocks.

Clipboard permissions are pre-granted globally in `use.permissions: ['clipboard-read', 'clipboard-write']` so flows can assert `navigator.clipboard.readText()` for share-link outcomes.

### Build + serve

`scripts/build-flows.ts` does a clean rebuild of `public/flows/` from `tests/e2e/output/flows/` (deletes everything first, then copies — stale flows whose tests no longer exist get reaped). Walks `<slug>/<locale>/<variant>/` recursively; only copies `manifest.json` + `*.png`.

The `<Flow>` component (`app/components/content/Flow.vue`) fetches the manifest using `useRequestURL().origin`-prefixed URLs so SSR works — Nitro's dev SSR `$fetch('/flows/...')` does NOT route through Vite's static handler. Variant resolution: subscribes to `useColorMode().value`, picks the matching manifest with a 4-step fallback chain (current locale + variant → opposite variant → defaultLocale + variant → defaultLocale + opposite). `baseUrl` derives from the manifest's OWN locale + variant so image paths can never drift from caption paths.

### Slides UI

YouTube-video pattern. The `<Flow mode="slides">` rendering:

- **Frame** with browser chrome + screenshot + cursor + highlight overlays + subtitle overlay (translucent dark backdrop + white text + center-bottom of the frame, fades between slides via `<Transition>`).
- **Click anywhere on the frame** toggles play/pause.
- **Progress bar** flush against the bottom of the frame (zero gap), 1px tall, blue fill. Width = `(slideIdx + playProgress) / total`. During autoplay `playProgress` animates 0→1 over 3s linear so the bar fills smoothly; on advance, `slideIdx++` and `playProgress` resets to 0 — no visual jump because the value is continuous.
- **Control bar** below the progress: borderless icon buttons (skip-back, play/pause, skip-forward) on the left, monospaced "N / total" counter on the right.
- **Autoplay**: 3s per slide (`SLIDE_DURATION_MS`). Stops at the last slide; restarts from slide 1 if user hits play again. Manual prev/next interrupts. Spacebar toggles when slides container has focus.
- **Pause snaps `playProgress` back to 0** (predictable: paused at the start of the current slide).
- **Article-level CSS grid** (`.docs-content > :deep(.docs-wide)`) lets flows break out left + right of the prose strip. Capped at 1100px on ultra-wide screens. Prose stays in the narrow center column (`min(72ch, 100%)`).

### Layout (`app/layouts/docs.vue`)

Sidebar pinned to the viewport's LEFT edge (no centered wrapper margin), border-right separator, sticky scroll, top-right color-mode toggle. Drops the auto-rendered "Docs" parent node from the nav tree (the layout's `/docs` brand link covers it) so top-level sections render directly. `SidebarItem.vue` renders folders as `<details>` for native collapsibility, auto-expand on the active branch, filters out `folder/index.md` self-children via path equality.

### Ephemeral test stack

Lives in `docker-compose.test.yml` under `profiles: [flows]` — adds `sync-test` + `markitdown-test` to the integration-test infra (postgres, valkey, seaweedfs, stripe-mock), all on isolated ports (5433/6380/8334/4002/8081). Integration runs (`docker compose up`) skip the flow-only services; flow runs (`--profile flows`) include them.

Lifecycle: `bun run flows:test:ephemeral` (`scripts/flows-ephemeral.ts`) does docker-up → spawn `bun run dev` on PORT=3001 with env vars overridden to talk to the test infra → poll `/api/health` → run Playwright with `PLAYWRIGHT_BASE_URL=http://localhost:3001` → cleanup on every exit path. Cleanup deliberately does NOT use `--remove-orphans` because that flag treats other compose files in the same project namespace as orphans and would nuke dev infra.

### When you add a new flow

1. Add stable selectors to the relevant components (`data-testid` for non-text elements, `aria-label` for icon-only buttons — both are accessibility wins independent of testing).
2. Write the test. Title becomes the slug (`'Quick share'` → `quick-share`). Use `editor.recordPreamble()` if the flow IS about doc creation, `editor.silentSetup()` otherwise.
3. Add real assertions. The flow is a test; if there's no behaviour to assert beyond "the screenshots look right", reconsider the flow.
4. Author the docs page under `content/docs/<section>/<slug>.md` with frontmatter (`title`, `description`, `category`, `order`, optional `featured`). Embed the flow with `::flow{id="<slug>" mode="slides" hide-title}::`.
5. Run `bun run flows` (test + build) to verify. The dedup notice in stdout flags shots that didn't visually change since the previous one — confirm intentional or remove the redundant step.

---

## 15. Business Model & Unit Economics (design — not yet implemented)

This section captures the pricing design for the four-tier subscription model. **No code exists yet**; this is the plan. The real implementation requires `users.plan` + Stripe integration + an interaction counter threaded through every AI call site. See TODOs.

### Tier structure

Four tiers, per-user subscription. One flat-rate model — no pay-as-you-go overages at launch.

| Tier | Price | AI actions / period | Key differentiator |
|---|---|---|---|
| **Free** | $0 | 100 / mo | Try the product; funnel into paid |
| **Pro** | $10/mo | 1500 / mo | Solo power users; personal AI only |
| **Max** | $50/mo | 8000 / mo | Small teams; can toggle workspaces `(+)` so member usage bills to them |
| **Ultra** | $100/mo | 16000 / mo | Large teams; same `(+)` mechanics, bigger pool |

Monthly reset for ALL tiers. Earlier draft gave Free a daily bucket (5/day); dropped it — a per-day cap is too fragmented for a user to complete any meaningful doc-editing task in one sitting, which kills the funnel signal ("I tried it for ten minutes and ran out"). One monthly pool lets Free users burst-try the product (draft one doc with AI help, hit the cap, upgrade). Paid resets align with the Stripe billing-cycle anchor; Free resets on the calendar-month boundary.

### The `(+)` workspace concept

- **Pro users cannot toggle `(+)`.** Their subscription is personal-only. Members they invite to their workspaces still use their own (likely Free) quota.
- **Max and Ultra users can toggle any workspace they OWN to `(+)`.** While `(+)`, every AI call made by ANY member of that workspace is billed to the owner's quota. No per-member caps, no member-count caps — if you have 50 people burning your pool, that's your problem to manage (and your signal to upgrade or deactivate `(+)`).
- **Deactivating `(+)` is instant.** Members revert to their own quotas on the next call. Useful for owners watching their pool drain.
- **Ownership transfer:** `workspaces.billing_owner_id` (separate from `ownerId`) drives billing. If a Max owner leaves and hands the workspace to a Free user, `(+)` auto-disables. If they hand it to another Max/Ultra user, billing continues to the new owner from that point forward.
- **Plan-downgrade handling:** if a Max owner's subscription lapses, `plan_valid_until` grants them the benefits through end-of-billing-period; after that, `(+)` auto-disables via a sweep job.

### What is an "AI action" / "interaction"?

One unified counter across all AI-cost-incurring operations. Billing term (user-facing): **"AI action"**. Internal term (code + DB): **"interaction"**.

| Operation | Interactions charged |
|---|---|
| 1 model turn in the agentic loop (any prompt → one round-trip to Gemini, whether it emits a tool call or final text) | **1** |
| 1 grounded turn (the turn that invokes `web_search` or `fetch_url`) | **5** |
| 1 generated image at 0.5K (current default) | **5** |
| 1 minute of dictation or voice-input transcription | **5** |

A single `/api/ai/prompt` request that runs a 4-turn agentic loop where turn 3 calls `web_search` costs: `1 + 1 + 5 + 1 = 8 interactions`. This is why the UI MUST show live interaction count during the loop — users can't predict cost otherwise.

Embedding calls on knowledge upload are NOT counted — already bounded by the per-file knowledge cap (100 files Pro, etc.).

### Model + resolution choices (locked in)

- **Text model**: `gemini-3.1-flash-lite` for ALL tiers. No per-tier model upgrades — paying users get MORE of the same quality, not different quality. Keeps cost math predictable and avoids the trap where Ultra users burn budget 10× faster on a bigger model.
- **Image model**: `gemini-3.1-flash-image-preview` at **0.5K resolution** (was 1K; 33% cheaper per image, still sharp enough for inline paged.js render + PDF export at normal zoom). Pin in `config.google.imageResolution` so it can't silently escalate.
- **STT**: Cloud STT v1 `latest_long`.

### Unit cost math (current pricing, April 2026)

Per Gemini API docs. These numbers drive the tier sizing — re-run the calc if prices move.

**Prompt turn — gemini-3.1-flash-lite:**
- $0.25/M input, $1.50/M output.
- Typical turn: 6000 input tokens + 800 output tokens = `(6000 × 0.25 + 800 × 1.50) / 1,000,000 = $0.0027`.
- Upper bound (turn 10+, full accumulated context): ~15k input + 2k output = `$0.0068`.
- **Planning number: $0.003 per turn.**

**Grounded turn — `web_search`:**
- $0.003 (flash-lite inference) + **$14 / 1000 Google Search queries** after the free pool.
- Free pool: **5000 grounded calls/month shared across our entire Gemini-3 project** (not per-user).
- Once past free tier: `$0.003 + $0.014 = $0.017` per grounded turn.
- `fetch_url` using `urlContext` is NOT metered separately (verified at launch); counted as a normal turn cost unless Google pricing changes.

**Image generation — gemini-3.1-flash-image at 0.5K:**
- $0.50/M input + $0.045 per 0.5K image output.
- Input tokens per call (prompt + alt): ~300 tokens = ~$0.00015. Negligible.
- **Planning number: $0.045 per image.**
- (For reference: 1K = $0.067, 2K = $0.101, 4K = $0.151. We lock 0.5K to avoid cost creep.)

**Dictation — Cloud STT v1 `latest_long`:**
- **$0.016 per minute.** Hard per-minute caps (30 min/day Free, 60 min/day paid) back up the interaction counter.

### Blended real cost per interaction

Assume a typical usage mix across all interaction types:
- 70% simple prompt turns
- 10% grounded turns (past free pool)
- 10% generated images
- 10% speech minutes

For each interaction actually charged to a user, how much does it cost us on average?

- Simple turns: 70% × $0.003 ÷ 1 interaction/turn = **$0.0021 per interaction**
- Grounded turns: 10% × $0.017 ÷ 5 interactions/turn = **$0.00034 per interaction**
- Images: 10% × $0.045 ÷ 5 interactions/image = **$0.0009 per interaction**
- Speech: 10% × $0.016 ÷ 5 interactions/min = **$0.00032 per interaction**

**Weighted blended cost per interaction: ~$0.00366** ≈ **$0.0037**.

Adjust upward if users skew image-heavy or grounded-heavy; adjust downward if they skew text-only (typical for doc editing, so $0.0037 is conservative).

### Tier budget derivation

Stripe fees: 2.9% + $0.30 per charge. After-fees net:
- $10 Pro → $9.41 net
- $50 Max → $48.25 net
- $100 Ultra → $96.80 net

Infra overhead per paid user (Postgres, Valkey, S3 storage, backups, GlitchTip, Traefik amortised, Hocuspocus): estimated **$0.50/user/mo**. Net after infra:
- Pro: $8.91
- Max: $47.75
- Ultra: $96.30

**We deliberately chose a lower at-cap margin (~40%)** to be generous with users during growth. The bet: model prices will drop over time while capabilities stay flat or improve. Caps stay constant; unit cost falls; margin rises. Retention beats margin in the first 12-24 months.

Budget math at 40% margin on the after-infra net:
- Pro: $8.91 × 0.60 = $5.35 AI budget → $5.35 / $0.0037 = **~1445 interactions** → round to **1500/mo**
- Max: $47.75 × 0.60 = $28.65 AI budget → $28.65 / $0.0037 = **~7740** → round to **8000/mo**
- Ultra: $96.30 × 0.60 = $57.78 AI budget → $57.78 / $0.0037 = **~15,620** → round to **16000/mo**

Free:
- 100 interactions/mo. Real cost at cap: 100 × $0.0037 = **$0.37/mo worst case**. Average Free user hits ~30% of cap = $0.11/mo. Acceptable customer-acquisition cost — lower than the daily-cap variant ($0.55 worst case) because the monthly cap is lower in absolute terms (100 vs 150), and real-world monthly utilisation on a "try it once and upgrade" funnel is closer to 20-30% of cap than the 100% a daily bucket would force.

### At-cap margin analysis (worst case — all users max their cap)

| Tier | Revenue net of Stripe + infra | Interactions | AI cost at cap | Margin at cap |
|---|---|---|---|---|
| Pro | $8.91 | 1500 | $5.55 | **38%** |
| Max | $47.75 | 8000 | $29.60 | **38%** |
| Ultra | $96.30 | 16000 | $59.20 | **39%** |

Thin but positive. Real margin is much higher — SaaS norm is 15-30% of users hitting their cap, which gives effective margin in the 70-80% range. The thin at-cap number is insurance against heavy-use outliers, not the expected case.

### Average-case margin (expected reality)

Assuming 30% average cap utilisation (typical SaaS):
- Pro avg cost: $5.55 × 0.3 = $1.67 → margin **81%**
- Max avg cost: $29.60 × 0.3 = $8.88 → margin **81%**
- Ultra avg cost: $59.20 × 0.3 = $17.76 → margin **82%**

This is what the business looks like in reality. The thin at-cap margin only matters for the ~5-15% of users who heavily utilise.

### Non-interaction caps per tier

Storage + count caps, separate from the interaction counter:

| | Free | Pro | Max | Ultra |
|---|---|---|---|---|
| Workspaces you own | 1 | 10 | 30 | 100 |
| `(+)` workspaces (subset of above) | — | — | unlimited | unlimited |
| Knowledge files | 5 | 50 | 500 | 2000 |
| Knowledge bytes total | 50 MB | 2 GB | 10 GB | 50 GB |
| Dictation hard cap | 5 min/day | 30 min/day | 60 min/day | 60 min/day |
| AI sessions concurrent (per user) | 1/doc | 1/doc | 1/doc | 1/doc |

The `workspaces.maxPerUser` cap is enforced at `/api/workspaces` POST time (already implemented as a single number; needs per-tier split). Knowledge caps are already per-user + per-workspace (§8); needs tier-aware upgrade to the config.

### The grounded-search free pool — a shared resource

Google gives **5000 free grounded calls/month shared across the entire Gemini-3 project** (not per-user). With 100 paying users doing 10% grounded queries at 1500/mo average = 15,000 grounded calls/mo. The free pool covers the first 5000; remaining 10,000 cost $140/mo aggregate.

This is factored into the blended cost via the $0.017-per-grounded-turn assumption (which already prices past the free pool). No per-user gating needed — the 5× interaction multiplier on grounded turns self-rate-limits heavy searchers.

### Levers we deliberately chose NOT to pull (for now)

We considered these for cost reduction but rejected to keep the implementation simple and the quality stable. Documented here so future-us can revisit when we genuinely need to reclaim margin.

1. **Switching to `gemini-2.5-flash-lite` ($0.10/M in, $0.40/M out — 3× cheaper).** The 2.5 model is measurably worse at multi-tool agentic loops and long-context reasoning. The system prompt has ~30 rules it needs to follow; 2.5 drops some of them. Revisit when we've built an eval harness to measure real quality degradation.
2. **Turn-adaptive model selection (2.5 for turns 1-3, 3.1 for 4+).** Same rationale as above; adds complexity.
3. **Grounded-result caching in Valkey.** 20% cache hit would save ~20% on grounded costs, but the 5000/mo free pool covers us initially. Add when grounded spend becomes meaningful.
4. **Context pruning on long agentic loops.** Would cut turn-10 cost by ~50%, but average loop is 3-5 turns so the savings are modest.
5. **Output-length control via system prompt.** Would save ~20% on output tokens. Cheap win, might ship opportunistically during a prompt refactor.
6. **Per-tier model quality.** Max/Ultra getting `gemini-pro` would let you charge more but would 10× their burn rate — users would hate the budget math. Flat model, flat math.

### The bet on model pricing

Gemini pricing has dropped meaningfully over every major-version release. Flash-lite costs today are ~30% of Flash-1.5's original pricing at launch. If the trend continues:

- **If flash-lite drops 40%** (plausible within 12 months): interaction cost drops from $0.0037 to $0.0022. At-cap margins jump from ~38% to ~63% with NO change to tier caps or prices.
- **If it drops 60%** (optimistic): cost to $0.0015, at-cap margins at ~75%. Effectively the SaaS-typical margin.

Caps stay constant, prices stay constant, margins rise passively. This is the core economic bet.

If prices instead RISE (unlikely but possible — specialty inference gets scarcer as demand grows), we can pull the levers above without a user-visible price change: cache more aggressively, prune context, switch to 2.5 for simpler turns. All are implementation changes, not billing changes.

### Implementation requirements (NOT YET DONE)

- Schema: `users.plan`, `users.plan_valid_until`, `users.stripe_customer_id`, `users.stripe_subscription_id`, `workspaces.billing_owner_id`, `workspaces.ai_enabled` (the `(+)` flag).
- Tier config split in `nuxt.config.ts`: `tiers.{free,pro,max,ultra}` with every existing `knowledge.*` + `workspaces.maxPerUser` + new interaction caps.
- `resolveBillingContext(userId, workspaceId)` helper returning `{ plan, attributedTo }`. `attributedTo` keys into the interaction counter — either `user:N` or `workspace:abc`.
- Interaction counter in Postgres (not Valkey — billing is correctness-critical; Valkey can evict under memory pressure). New table `ai_usage_period` with `(attributedTo, periodStart, interactionsUsed)`, atomic INCR per turn.
- `runLoop.ts` decrements before each `ai.models.generateContent*` call. Mid-loop exhaust → graceful abort with a doc insert: "Your AI budget is exhausted. Ask the workspace owner or upgrade your plan to continue."
- Stripe: checkout endpoint, billing portal, webhook. ~200 lines.
- UI: `/pricing` page, interactions-remaining display in `AIPromptBar`, `(+)` badge in workspace header, plan-downgrade sweep job for lapsed `(+)` workspaces.

Realistic scope: 5-7 days end-to-end including Stripe integration and UI polish.

---

## 16. Shipped Features

**Infrastructure:** Compose stack, Drizzle + versioned migrations at boot, y-postgresql persistence, S3 singleton, Markitdown service, daily pg backup sidecar with retention pruning, GlitchTip observability, Valkey rate limiting, dual-secret rotation, inactive doc sweep, PWA.

**Auth & editor:** GitHub + Google OAuth, `SESSION_VERSION` invalidation, anonymous doc creation, CodeMirror 6 + yCollab, split editor/preview, formatting toolbar + status bar, welcome doc, i18n (en complete; others scaffolded).

**Collaboration:** Awareness (names/colors/avatars), PresenceBar, Y.js title sync, share modal with access-mode selector, scrypt password protection (3-layer), activity feed (500 cap/doc), remote deletion broadcast via `ymeta._deleted`.

**Files & import/export:** Presigned upload flow (request → PUT → confirm) + DB tracking, drag-drop + paste upload, markitdown import (DOCX/PDF/PPTX/XLSX/HTML/EPUB), client-side `.md` download, client-side PDF via paged.js + `window.print()`.

**Preview & PDF:** paged.js pivot (A4/Letter pages, header/footer, footnotes via `float: footnote`), single `themeToCss()` for preview + print, iframe isolation, responsive page zoom, `Cmd/Ctrl+P` hijack, dark mode chrome, snap-to-bottom guard, image `decode()` before paginate.

**Theme system:** Per-doc JSONB + `ymeta.theme` live broadcast, server validation, `ThemeEditorPanel.vue` (11 sections), 6 built-in presets, 20-font Google Fonts picker, TOC controls (`maxDepth`/`showTitle`/`showPageNumbers`/`leaderStyle`), mermaid theme picker, header/footer token chips.

**Markdown extensions:** Batch 1 (attrs/mark/ins/sub/sup/dl/abbr/figure/img-size), Batch 2 (katex + alerts), Batch 3 (anchor + TOC + Mermaid, 8 diagram kinds), page break (`<!-- pagebreak -->`), `markdownReference.ts` for AI vocabulary.

**Editor chrome:** Google-Docs-style menu bar (File/Edit/View/Insert/Format/Sharing/Help), table size picker (8×8 modal), diagram/alert/math dropdowns, right sidebar (Activity OR Theme), view-mode toggle (Edit/Split/Preview), `DeleteConfirmModal`.

**Workspaces:** Three-role model (admin/editor/viewer), invite-by-email, last-admin invariant, cascade delete, role-gated UI at `/w/:id`, workspace doc table. Docs are moveable between workspaces post-creation via PATCH /api/docs/:id/workspace.

**Document duplication:** `POST /api/docs/:id/duplicate` clones a doc end-to-end — new `documents` row (duplicator becomes owner), Y.js state with image-URL rewrite (reconstructs the source Y.Doc via `yjs_documents` replay, rewrites `/api/files/{sourceDocId}/` → `/api/files/{newDocId}/` in the markdown, re-encodes as a single initial update), and S3 image assets via `CopyObject` into the new prefix. Permissions inherit automatically from the target workspace. See `server/utils/duplicateDocument.ts` + `server/utils/cloneYjsState.ts`.

**Workspace knowledge base:** upload PDFs/DOCX/PPTX/XLSX/HTML/EPUB/MD/TXT to a workspace; pipeline is presigned S3 PUT → `file-type` magic-byte sniff at confirm → markitdown parse → heading-aware chunker (with 300-chunk ceiling + sentinel truncation) → `gemini-embedding-2-preview` at 768-d MRL → pgvector chunks + generated `tsvector` for BM25. Hybrid search via RRF on `search_knowledge`; full-markdown retrieval via `get_knowledge_file` (both exposed only when session has workspace membership). Original S3 object deleted after successful processing (only parsed markdown + embeddings retained). Abuse limits: 30 presigns/min/user rate-limit + per-workspace (500/1 GB) + per-user (100/2 GB) caps + Valkey inflight counters + confirm-time Postgres advisory lock. Background sweeps: stuck-processing retry (10 min TTL) + failed-row cleanup (7 day TTL). UI lives both in `/w/:id` and in the editor's right sidebar (library icon next to Activity + Theme). See §8.

**AI:** Gemini agentic loop with 9 tools: `view_document`, `replace_text`, `insert_text`, `update_theme` (partial patches + 6 presets), `set_title`, `view_image` (multimodal — smuggles bytes via `extraParts` since functionResponse is JSON-only), `generate_image` (Gemini image-model → S3 → markdown ref), `web_search` (grounded sub-call), `fetch_url` (urlContext sub-call with structured output). Single unified path: both the bottom `AIPromptBar` and the selection-scoped `AISelectionPopup` call `/api/ai/prompt`; the popup pre-captures a `kind=selection` `EditorSelectionSnapshot` so the agentic loop's `<editor_state>` wrapper steers the model toward `replace_text`. Awareness-based status propagates to the prompt bar placeholder and presence-bar tooltip. Per-user-per-doc cap via Postgres UNIQUE index, initiator-only cancel, floating prompt bar (rainbow ring animation on any active session). Configurable thinking budget (`NUXT_GOOGLE_THINKING_BUDGET`, default 0). **Editor-state context:** every prompt ships with an `<editor_state>` wrapper carrying cursor line + column + surrounding line text with a `<CURSOR_IS_HERE>` marker so the model can resolve "add X here" / "fix this" without counting characters — handled in `server/utils/agentic/editorStatePrompt.ts` and validated client-side in `app/utils/editorSelection.ts`. **Voice input for the prompt bar:** mic button → `MediaRecorder` opus/webm → base64 → `/api/ai/transcribe` (Cloud STT sync `recognize` → text) → auto-submit. Live frequency-bar visualiser via `AnalyserNode`, MM:SS timer with amber@-10s/red@-5s, 60s cap, cancel button, hard 5 MiB payload ceiling, explicit `MediaStream` cleanup so the browser mic indicator clears immediately. Language auto-picks from the UI locale. **Live dictation:** mic button in the formatting toolbar → Nitro WebSocket relay (`/api/ai/dictate`, JWT via first message — NOT `?token=`) → Cloud STT streaming → interim partials render as grey italic ghost text at the CM6 caret (CM6 `StateField` + `ViewPlugin`), finals commit into Y.js via `ydoc.transact(fn, 'dictation:{userId}')` with smart spacing (mid-word inserts a leading space so `fo|o` + "bar" becomes `fo bar o`). Language from UI locale. One session per user via Valkey `SET NX PX` lock, 30 min/user/day audio budget, 10 min/session cap, 30s idle timeout. Click-anywhere-and-continue: the ghost text reanchors to the new caret because the view plugin rebuilds on `selectionSet`. Straggler-chunk guard silently drops audio that arrives after `stop` so the client never sees "write after end" as an error.

**Security hardening:** Fail-fast env, rate limits, file access control, `meta.put` validation, 2h password token expiry.

**Mobile:** Touch-optimized CM6 (16px font via Compartment), flex-wrap toolbar, hamburger menu, 640px breakpoint.

**Flow docs system:** Playwright-driven tests that double as a documentation site at `/docs`. Each flow is one user-job (`quick-share`, `polished-pdf`, etc.) — the test asserts real product behaviour AND records a slideshow with browser-chrome address bar, animated orange-glowing cursor, pulsating highlight callouts, subtitle-style captions, and YouTube-style autoplay (3s/slide, click frame to toggle, progress bar fills smoothly). Per-locale + per-variant capture (`<slug>/<locale>/<variant>/manifest.json` + screenshots); Vue `<Flow>` component picks the matching variant from `useColorMode()` with a 4-step fallback chain. SSR works via `useRequestURL().origin`-prefixed fetches. Flow tests run against an ephemeral docker stack (`docker-compose.test.yml --profile flows`) so they never see stale dev state. Shipped flows: `quick-share` (write & share a doc, ends at "link in clipboard"). See §14b for the full pipeline.

---

## 17. TODOs

### MVP leftover
- [ ] DNS: `yourdomain.com`, `sync.` subdomains (prod deploy)
- [ ] CORS: Traefik middleware for S3 (prod deploy)

### Monetisation (design locked in; see §15)
- [ ] Schema: `users.plan` + `plan_valid_until` + `stripe_*` cols; `workspaces.billing_owner_id` + `ai_enabled`
- [ ] `tiers.{free,pro,max,ultra}` config split (split current `knowledge.*` + `workspaces.maxPerUser`)
- [ ] `resolveBillingContext(userId, workspaceId)` helper → `{ plan, attributedTo }`
- [ ] `ai_usage_period` table + atomic interaction counter threaded through `runLoop.ts` (decrement pre-call; mid-loop exhaust → graceful doc insert with upgrade CTA)
- [ ] Stripe checkout + billing portal + webhook (`sub.created/updated/deleted`)
- [ ] `/pricing` page + plan badges + interactions-remaining display in `AIPromptBar`
- [ ] `(+)` workspace toggle (admin/editor UI; Max/Ultra only) + sweep job that flips `ai_enabled=false` on lapsed owners

### MMP

**History & snapshots**
- [ ] Timestamped snapshots in S3 via Hocuspocus hook
- [ ] History view: load any snapshot into fresh Y.Doc
- [ ] Timeline scrubber, diff view, restore, export at point

**Theme system**
- [ ] Phase 4: User-saved themes — `themes` table + CRUD endpoints

**Markdown extensions**
- [ ] Batch 4: `markdown-it-criticmarkup`, `markdown-it-multimd-table`, client-side BibTeX citations

**Power features**
- [ ] Markdown frontmatter (export theme/title; import interprets it)
- [ ] Command palette
- [ ] Table of contents sidebar
- [ ] Markdown folding per-chapter / sub-chapter etc
- [ ] Markdown highlighting
- [ ] QR code sharing
- [ ] Keyboard shortcuts cheat sheet
- [ ] Y.js document compaction for oversized docs
- [ ] Remaining locale translations (de, fr, es, ja, zh)
- [ ] Markdown export with base64-inlined images

**Mobile MMP**
- [ ] Floating toolbar above virtual keyboard via `visualViewport`
- [ ] Bottom tab bar (Edit / Preview / AI)
- [ ] Sidebar as bottom sheet

**AI**
- [ ] Semantic search across docs via `ai.models.embedContent()` — "find the section about X", "suggest related docs"
- [ ] Safari support for voice input / dictation — Safari's `MediaRecorder` only emits `audio/mp4` (AAC) which Cloud STT sync doesn't accept. Options: server-side ffmpeg transcode on upload, or route Safari through Cloud STT's batch Files API which DOES accept MP4.

**Flow docs system (see §14b)**
- Tier 1 flows still to ship: `polished-pdf` (theme + PDF export), `import-existing` (DOCX/PDF → markdown), `rich-content` (tables/alerts/math/diagrams reel), `password-protect` (gated share — needs the second-context fixture).
- [ ] Two-context fixture for the password-protect flow ("incognito" gate demonstration).
- [ ] Selective re-runs: `flows:test:changed` script that diffs `tests/e2e/flows/` against last commit and only re-shoots changed tests. Defer until ≥6 flows × 2 variants makes CI cost noticeable.
- [ ] CI: GH Actions PR job runs `flows:test:ephemeral` and fails on regression; main-merge job re-runs all flows + auto-commits updated PNGs with `[skip ci]`.
- [ ] Search via `queryCollectionSearchSections` once we have ≥4 flow pages worth searching.
- [ ] Doc-content i18n pattern: `content/<locale>/docs/...` wired to `useI18n().locale`. Establish + translate one Tier 1 flow as a proof.
- [ ] `/docs/_internal/flows` gallery page listing every flow at once for QA + triage.
- [ ] Mobile flow project (separate Playwright project, 375×667 viewport, dedicated `MobileEditorPage` page-object).

**AI (explicitly out of scope for now):**
- Multi-turn conversation history, streaming text to UI, activity attribution "AI for Alice", user-selectable model, grounded-search caching, cost telemetry, provider-swap adapter.
- **Generic image search** (Bing deprecated, Google CSE costs $5/1k after 100/day, Brave is viable but not yet needed, DDG unofficial violates ToS). Covered indirectly: `fetch_url` extracts image URLs from a user-named source page, which handles the "image of X from their website" case without a search API. Revisit (Brave or self-hosted SearXNG) when users ask for sourceless image search.
- **Pexels/Unsplash stock-photo search** — stock-only, misses the "image of a specific person/entity" case, and `generate_image` covers the generic "illustration of X" case. Not worth a tool slot.

---

## 18. Technical Decisions

| Decision | Rationale |
|---|---|
| Full-stack Nuxt over SPA + Fastify | One Bun process for SSR + API + auth |
| `nuxt-auth-utils` over `@sidebase/nuxt-auth` | Lighter; sealed-cookie sessions; built-in scrypt |
| Drizzle + Postgres | Versioned migrations, concurrent writers, `pg_dump` backup path |
| Single `pg` driver stack-wide | `y-postgresql` requires `pg.PoolConfig`; mixing = two pools |
| `y-postgresql` (was S3 blob overwrite) | Append+merge is durable; failed write can't nuke state |
| Text-enum columns, not `pgEnum` | Adding values is TS-only — no `ALTER TYPE` friction |
| `nitro.preset: 'bun'` | lib0 and other packages use Bun-specific conditional exports; `node-server` preset traces wrong condition |
| Hocuspocus as separate container | Long-lived WS + in-memory Y.Doc state shouldn't share Nitro event loop |
| `SESSION_VERSION` invalidation | Simpler than backwards-compat shims pre-launch |
| paged.js in srcdoc iframe | paged.js mutates global state; host-page approach caused unrecoverable layout jitter |
| Single `themeToCss()` for preview AND print | One function, two consumers — genuine WYSIWYG |
| Client-side PDF via paged.js + `window.print()` | No server Chromium, no queue, no S3 round-trip |
| Drop DOCX/HTML export | Maintenance burden; markdown + PDF covers all real needs |
| Markitdown over pandoc | 1.1 GB → 615 MB image; import-only use case doesn't need pandoc's output formats |
| CDN for paged.js / hljs / KaTeX / Mermaid | Vite can't inject into srcdoc iframes; versioned CDN URL = automatic cache-bust |
| Mermaid pre-process before paged.js | paged.js sees plain inline SVG; no runtime rendering during pagination |
| Zod as AI-tool source-of-truth | `z.toJSONSchema` generates Gemini schema + runtime validator; malformed args self-correct |
| Custom `web_search` wrapping `googleSearch` | `googleSearch` + `functionDeclarations` coexistence shifts between model versions; wrapping also gives pre-call status UX |
| Structured output for `fetch_url` but NOT `web_search` | `urlContext` + `responseSchema` works; `googleSearch` + `responseSchema` 400s across versions. `web_search` keeps freeform answer + `groundingMetadata` for sources |
| `ToolResult.extraParts` for binary tool outputs | Gemini `functionResponse.response` is JSON-only; `view_image` smuggles inline image bytes as sibling parts on the same user message |
| External image URLs for search results, not rehost | Link-rot vs. copyright — hosting arbitrary images we didn't license is the bigger risk. Opt-in `archive_image` for the exceptions |
| Thinking budget default 0 (disabled) | Keep minimal-by-default for cost/latency; operator opts in per env. Only pass `thinkingConfig` when budget > 0 — older `flash-lite` 400s on an empty config |
| Implicit Gemini prefix cache, no explicit `ai.caches.create` | The automatic prefix cache handles both within-loop sharing and cross-user system-prompt sharing for free; explicit caching has minimum-size, storage-cost, and TTL-refresh overhead that only pays off on bursty traffic patterns we don't have |
| `generate_image` returns markdown, does NOT place it | Separation of concerns — AI decides whether to `insert_text` / `replace_text` / replace an existing image. Initial version bundled placement; felt too opinionated |
| Derive preset/font lists into system prompt at module load | Prevents drift between `THEME_PRESETS` / `THEME_FONTS` and what the system prompt claims the AI can use |
| `scripts/audit-markdown-pipeline.mjs` as source of truth for `markdownReference.ts` | AI was being told syntaxes that didn't actually render (e.g. `![alt](url =50%)` from @mdit/plugin-img-size). Only document what the full pipeline — markdown-it + plugins + DOMPurify — actually emits |
| Table size picker as UModal | Anchored popover had trigger location and click-competition issues; centered modal sidesteps both |
| Gemini over Claude | Materially cheaper; display name vendor-neutral ("AI Assistant") |
| Cloud Speech-to-Text over Gemini Live / Gemini inline audio | Gemini Live is a conversational duplex model: server-side VAD buffers audio until end-of-turn, so "I spoke 30s without a pause" showed nothing until stop — wrong model for dictation. Gemini inline audio works for one-shot but costs ~4× per minute. Cloud STT is purpose-built for streaming STT, cheaper per minute, and lets Feature A and Feature B share one vendor + quota + billing line |
| Cloud STT v1 (not v2) | v2's `streamingRecognize` requires a project id in the recognizer path (`projects/{project}/locations/...`); v1 doesn't. Our API-key auth gives us the project implicitly — v1 keeps the server code to a single SDK call with no path construction. `chirp_2` is v2-only but `latest_long` in v1 is plenty for dictation quality |
| Split Google API keys (Gemini + Cloud STT) | Two separately-restricted keys in GCP so a leak of one doesn't pivot to the other. Separate billing lines too. Cost: two env vars instead of one — trivial |
| Separate `dictateJwtSecret` | Rotate independently of the Hocuspocus secret so compromising one surface doesn't forge tokens for the other. Falls back to `jwtSecret` for dev |
| JWT in first WS message, NOT `?token=` | Query-string auth leaks into access logs, referer headers, and browser history. First-message auth keeps the URL credential-free. Cost: ~10 extra lines of state machine for the pre-auth vs post-auth branches |
| Valkey-backed concurrent-session lock | In-memory `Set<userId>` silently fails when Nitro runs behind Traefik with multiple workers/containers. `SET NX PX` is cluster-consistent in one RTT. Fails CLOSED on Valkey errors (correctness lock, not a rate limit — failing open would double-bill GCP) |
| Audio-ms budget, not request count | Dictation billing is per audio-second; rate-limiting by request count is the wrong unit. `consumeRateLimitBudget` tracks a signed counter (`cost` per debit, peek via `cost: 0`) so one "request" can debit arbitrary ms. The peek returns `maxCost - current` — NOT a naive `maxCost` — so the session-open check actually rejects exhausted users at open time |
| Voice input (Feature B) auto-submits after transcription | Picks the "Siri-like" feel over "Google Docs voice typing"-style manual confirmation. The transcript briefly lands in the input field (150ms) so the user sees what was heard before it's sent — silent auto-submit feels like a black box when the model mishears |
| Hand-rolled canvas visualiser over a library | The Vue ecosystem has no good "live recording bars" library; `wavesurfer.js` is playback-focused and `vue-audio-visual` is unmaintained. An `AnalyserNode` + 40-line canvas draw is smaller, theme-aware, and zero-dep |
| Voice input skips `requireDocEditAccess` | Transcription doesn't touch the doc — it returns bytes-to-text. The downstream `/api/ai/prompt` call (triggered by auto-submit) enforces the content-edit gate. Adding it to `/api/ai/transcribe` would only duplicate that check |
| Dictation mock behind `NUXT_GOOGLE_SPEECH_MOCK=1` | Lets integration tests drive the full WS state machine (handshake → partials → finals → close) without hitting Google. Fake SpeechClient emits canned responses on fixed chunk thresholds so `partial` → `final` ordering is deterministic |
| `pgvector/pgvector:pg16` over stock `postgres:16-alpine` | Data-dir-compatible drop-in; avoids the "install pgvector at runtime" ceremony. Migration `0005` hand-prepends `CREATE EXTENSION IF NOT EXISTS vector` before the vector tables — drizzle doesn't emit extension DDL |
| 768-d Gemini MRL (not 3072) | HNSW caps at 2000 dims; 3072 forces IVFFlat (slower + worse recall at <10k chunks). 768 is Gemini's recommended lowest tier with minimal recall loss for doc-retrieval. `outputDimensionality: 768` on embedContent truncates via MRL in one SDK param |
| Loop per-chunk, NOT `contents: [str, …]` batch | Gemini JS SDK treats an array of strings as a SINGLE multi-part Content and returns ONE aggregate vector — Python SDK behaves differently. We run a bounded-concurrency (5) pool of per-chunk calls. Symptom if reverted: `expected N vectors, got 1` in logs |
| `RETRIEVAL_DOCUMENT` / `RETRIEVAL_QUERY` task-types | Task-type hints measurably improve retrieval recall over treating docs + queries identically (they land on slightly different sub-manifolds of the embedding space). Two code paths (`embedDocuments` / `embedQuery`) to keep the task-type pinned per use case |
| `embedding_version` column (`model:dims`) | Lets us detect stale vectors on future model/dim bumps without a destructive migration — can lazy re-embed on read or schedule a background reprocess |
| Hybrid RRF over stacked ranker | Reciprocal Rank Fusion (`k=60`) merges vector + BM25 ranks without tuning per-source weights. Each source contributes `1/(k + rank)`; chunks in both sources accumulate. Handles the "paraphrase" vs "exact phrase" split cleanly — `where_does_the_policy_say_about_X` hits vector; `section 4.3` hits BM25 |
| STORED generated `tsvector` + GIN | One-line drizzle `generatedAlwaysAs` keeps the search vector in sync with `content` without triggers or app-side maintenance. Write-time cost is worth it — the BM25 query hits GIN in microseconds |
| Two-phase presign (reserve-before-insert) | Same pattern as image uploads, but we ALSO reserve a Valkey inflight slot at presign and release it at confirm. Closes the "500 concurrent presign requests all read count=499" race that the pure DB-count check can't catch |
| Advisory lock at confirm, NOT presign | `pg_advisory_xact_lock(hashtext(wsId))` serializes the cap recheck + insert inside one txn. Presigning doesn't serialize — it's rate-limited + inflight-slot-tracked instead (signing is expensive and happens while the user is composing; serializing there would queue innocent clients behind an attacker burst) |
| Magic-byte sniff at confirm, not presign | At presign time we only have a filename; the bytes don't exist yet. Sniffing the first 4 KB of the uploaded object (via S3 Range GET) catches content/ext mismatches the signed `ContentType` can't (S3 stores whatever bytes the client PUT, not what was signed) |
| `file-type` library over hand-rolled magic | ZIP-based Office formats (DOCX/PPTX/XLSX) all start with the same `PK\x03\x04` bytes; differentiating requires parsing `[Content_Types].xml` inside the ZIP. `file-type` handles that + 50+ formats in a ~15 KB dep. Not worth reimplementing for uploads |
| Delete knowledge original after processing | We never serve the original back — only `markdown_cache` and embedded chunks. Keeping the raw file doubles storage and forces content-type concerns to live forever. Parsing failure keeps the file (for retry); success discards it |
| Per-user caps + per-workspace caps | Per-workspace alone lets one user fan out across 20 workspaces × 1 GB = 20 GB of "their" data. Per-user cap is the actual spend ceiling. Workspaces-per-user (20 owned) closes the "create 1000 workspaces first" vector |
| Failed-row TTL reap (7 days) | Failed rows still pin quota (their bytes count until deleted) and markdown_cache can be large. Keeping them around a week lets the user see + retry; reaping after prevents "deliberately failing uploads" from being a persistent quota-hoarding strategy |
| Chunker emits sentinel on overflow, doesn't fail | A 25 MB TXT with no structure produces thousands of tiny chunks → thousands of embedding calls. `maxChunksPerFile = 300` caps the cost; the last chunk is a "[truncated]" marker so downstream search still sees something at the truncation point |
| System prompt says "always end in insert_text or replace_text" | Early testing showed the model treating "summarize X" as a chat question and emitting plain text we have no UI to display. Explicit rule: EVERY turn ends in a doc edit; no clarifying questions (the user can't see them). Pairs with the editor-state routing to pick an insertion location |
| Flow tests double as docs (each is one user-job) | A separate "tour the editor" docs system + e2e suite would drift apart. Sharing the same artefact forces both to stay honest: if sharing breaks, the screenshots in the docs go stale AND the test fails. The cost is captioning discipline (no "Hocuspocus", no implementation jargon — see §14b) |
| Per-locale + per-variant manifest dirs | Captures the same flow in light + dark, en + de + …, so the docs site can match the reader's chosen theme without showing a jarring mismatch. Within-variant content-hash dedup means highlight-only updates don't double the disk cost. Cross-variant bytes always differ; no point in dedup there. |
| `flow.click` (hover → screenshot → click) instead of just `flow.step` | Click-then-navigate steps captured AFTER the click land on the destination page with the cursor at coords that made sense on page A's layout — meaningless on page B. Hovering FIRST puts the cursor on the target, screenshots, then clicks. The "Click X" caption now shows the click conceptually about to happen on the page where it makes sense |
| Subtitle overlay on the frame, not below it | Captions below the frame got skimmed past. Putting them OVER the screenshot — translucent dark backdrop, white text, center-bottom — gives them video-subtitle weight; readers absorb them as part of watching, not as supplementary text |
| `(slideIdx + playProgress) / total` for the progress bar | Naive `(slideIdx + 1) / total` shows 1/N at slide 1 — the user has watched nothing but the bar is already partly full. Splitting into `slideIdx` (slides done) + `playProgress` (intra-slide elapsed, animated 0→1 over the slide duration) means slide 1 starts at 0%, the bar fills smoothly during autoplay, and slide N ends at exactly 100% |
| Click anywhere on the frame toggles play/pause | YouTube pattern. Bigger target than the small play button in the control bar. Discoverable without instruction for anyone who's ever watched a video on a touchscreen |
| Single shared test compose (`docker-compose.test.yml --profile flows`) | Started with a separate `docker-compose.flows.yml`, immediately discovered the `--remove-orphans` footgun (it removed dev containers because they shared the project namespace). Folded sync + markitdown into the test compose under a `flows` profile: integration tests skip them by default, flow tests pull them in via `--profile flows`. One compose file, two use cases, no orphan-killing |
| 1280×800 capture viewport (not Full HD) | Docs cap embedded flows at ~1100px wide. Capturing at 1920 made everything downscale to ~57% — 16px UI text became ~9px on the page, hard to read. 1280×800 sits ~16% above the displayed width (sharp without being microscopic), well above the 640px mobile breakpoint, no responsive surprises |

---

## 19. Gotchas

- **`server/auth/` is not a Nitro route dir.** OAuth handlers live in `server/routes/auth/`.
- **`@nuxtjs/i18n` v10:** `lazy` removed — lazy is default when `locales[].file` is set. `langDir: 'locales/'` resolves relative to `i18n/`, not `app/`.
- **`markdown-it-emoji`** needs `.full`: `const emoji = (mod as any).full || (mod as any).default || mod`.
- **`highlight.js` CSS** must be dynamically imported inside `initMd()` — otherwise code blocks are all white.
- **CM6 `readOnly` must go through Compartments** — `isReadOnly` is async-set after `fetchToken`.
- **Single Awareness instance** — create in orchestrator, pass to both `HocuspocusProvider` and yCollab.
- **Y.js Map reactivity** — `ymeta.get('title')` isn't Vue-reactive; use `ymeta.observe()` → ref + computed.
- **`y-postgresql` 1.0.1** — force `useIndex: false` (SQL bug in index-creation branch).
- **Hocuspocus v3:** Use `Server` (not `Hocuspocus`) for standalone. Hook shapes vary — don't mutate connection object; use separate Maps.
- **Bun can't pre-bundle Hocuspocus** — run TS directly via `bun run src/index.ts`.
- **`nitro.preset` must match runtime** — default `node-server` breaks packages with Bun conditional exports (lib0).
- **Nitro NFT tracer misses `@google/genai`'s transitive `ws`** — fix with `nitro.externals.traceInclude: ['node_modules/ws/index.js']`.
- **Dev sync networking** — `host.docker.internal` + `host-gateway` on Linux; Nuxt dev must bind `0.0.0.0`.
- **Attribution fallback warning** — grep prod logs for `[hocuspocus] Attribution fallback` to detect drift.
- **Drizzle `node-postgres`** — Promise-returning, no `.get()`/`.all()`. Use `(await db.select()...limit(1))[0]`.
- **Never ship `passwordHash`** — always project explicitly on public endpoints.
- **Never issue usable JWT for forbidden/password-gated docs** — `token: null` prevents Hocuspocus connection.
- **Zod `z.tuple(...)` rejected by Gemini** — use `.array().min(N).max(N)`.
- **AI sweeper threshold must exceed prompt deadline** (7 min > 5 min) — otherwise legit long web searches get killed.
- **Presigned read URL TTL: 120s** — can't be revoked; long TTLs outlive access-mode/password changes.
- **Mobile breakpoint: 639px** — matches Tailwind `sm:`. Don't reintroduce 768px.
- **paged.js + iframe:** Polisher only processes `@page` from `stylesheets` arg (not `<style>` in content tree). Pass `[{ 'theme.css': cssText }]`. `Polisher.add()` takes `{filename: cssText}` map, not Style elements.
- **Margin boxes are siblings of `.paged-doc`, not descendants** — CSS custom properties don't propagate up. Bake `{title}`/`{date}` into the CSS string in `themeToCss`.
- **srcdoc iframe `postMessage`:** `targetOrigin: '*'` required — srcdoc has opaque origin in Chromium (`"null"`). Trust boundary: `e.source === iframe.contentWindow`.
- **CSS `zoom` not `transform: scale`** — `scale` leaves layout box full-size and overflows; `zoom` shrinks both.
- **Footnotes need `transformFootnotesForPagedMedia()`** — markdown-it-footnote puts all footnotes at end of doc; paged.js `float: footnote` needs inline `<span>` at the ref site.
- **Iframe bootstrap lives in `pagedPreviewIframe.html`, not a template literal** — imported as a raw string via `?raw`. URL placeholders (`__PAGEDJS_POLYFILL_URL__`, `__KATEX_CSS_URL__`, `__MERMAID_ESM_URL__`) are substituted at mount. If you ever inline it back into TS, remember to escape backticks (`` \` ``) — they close the outer template early.
- **Mermaid SVG overflow** — `overflow: visible` on `.mermaid svg` + `.mermaid foreignObject`, `white-space: nowrap` on inner elements. Use `htmlLabels: true` (foreignObject) — `htmlLabels: false` undersizes SVG `<text>` nodes.
- **srcdoc fragment links navigate the iframe** — capture `<a href="#...">` clicks in iframe bootstrap; `preventDefault + target.scrollIntoView()`.
- **`html: false` doesn't block manually pushed tokens** — custom block rules that call `state.push('html_block')` render verbatim regardless. Use this for controlled HTML emission.
- **TOC: anchor plugin must load BEFORE toc plugin** — `markdown-it-anchor` assigns IDs; `markdown-it-toc-done-right` reads them. Share one `slugify` function.
- **KaTeX inline `style`** — DOMPurify must allow `style` attribute; add `math`/`semantics`/`mrow`/etc. to the allowlist.
- **`renderMarkdown` always emits `language-${lang}` class** — even for unknown languages; required for mermaid detector to find `pre code.language-mermaid`.
- **Literal `@` in i18n locale JSON** — `@:key` is parsed as a linked message. Escape with `{'@'}` or reword to avoid `@` in string literals.
- **Workspace authz: one helper per concern.** `canEditDoc` (content), `canManageDoc` (sharing/delete), `canManageWorkspace` (admin actions). Mixing leaks permissions.
- **Removing a workspace member doesn't revoke active JWTs** — valid until next token refresh (up to 2h). Acceptable for now.
- **`workspaces.ownerId` vs `workspace_members.role='admin'`** — `ownerId` is provenance only, never used for authz. An original creator demoted to editor loses admin rights.
- **`@mdit/plugin-img-size` in our stack does NOT parse `=WIDTHxHEIGHT`** — despite the package's readme. Use the `@mdit/plugin-attrs` syntax instead: `![alt](url){width=50%}`. The audit script catches mis-documented syntaxes like this — always run it before adding claims to `markdownReference.ts`.
- **Gemini image model names drift** — before setting `NUXT_GOOGLE_IMAGE_MODEL`, verify with `curl "https://generativelanguage.googleapis.com/v1beta/models?key=$KEY" | grep image`. Example: `gemini-2.5-flash-image-preview` is NOT real (no `-preview`); the correct names are `gemini-2.5-flash-image` (stable) and `gemini-3.1-flash-image-preview` (current preview).
- **Gemini sometimes hallucinates tool outputs** — rather than emitting a `functionCall`, the model writes what it *thinks* the tool would return. Symptom: placeholder URLs like `/api/files/placeholder/joel.png`. Fix is in the system prompt: explicitly forbid fabricating `/api/files/...` paths, tell the model these ONLY exist after a real `generate_image` call.
- **`googleSearch` + `responseSchema` coexistence 400s on some models** — if you're adding a new grounded sub-call, stick to freeform text output and parse `groundingMetadata` for structure. `urlContext` + `responseSchema` does work (verified).
- **`z.string().trim().min(1)` ordering matters in Zod 4** — with `.min(1).trim()`, whitespace-only strings pass the min check and only collapse to empty later. Put `.trim()` BEFORE `.min(1)` so the length check sees the trimmed value.
- **`view_range: [-1, -1]` keeps coming back from the model** — enforce `start >= 1` with a `.refine` on the schema so Gemini gets a schema-level rejection it self-corrects from, instead of burning a turn on the handler's runtime error.
- **`@mdit/plugin-alert` doesn't support `> [!NOTE] Custom title`** — the text after `[!KIND]` on the first line is silently dropped and the block falls through to a plain blockquote. The `[!KIND]` line must be alone.
- **`data-*` attributes don't survive DOMPurify** — not in our `ALLOWED_ATTR`. If the AI tries to encode state via `data-foo="bar"`, it's silently stripped. Tell the AI only `class`, `id`, `style`, `width`, `height`, `aria-*`, `role`, `target`, `rel`, `title` survive on most elements.
- **`responseModalities: ['IMAGE', 'TEXT']`** — required on image-gen calls so the model can narrate alongside the image. But we ignore the text part in favor of the caller-provided alt; if the response has no `inlineData` part, surface the finish reason + text (it's usually a safety block with an explanation the user needs to see).
- **AI `extraParts` must come AFTER the `functionResponse`** — Gemini links binary parts to the most-recent function call on the same user message. Putting them before breaks the association.
- **`MediaRecorder` MIME preference order matters per browser** — Chrome/Firefox want `audio/webm;codecs=opus`, Safari falls back to `audio/mp4`. `useVoicePrompt.ts` probes `MediaRecorder.isTypeSupported()` in that order; the server's `ALLOWED_MIME` list must stay in lockstep or Safari recordings 400.
- **Always call `track.stop()` on every `MediaStream` track explicitly** — just stopping the `MediaRecorder` leaves the audio tracks live and the browser's "site is using your microphone" indicator stays on. Cleanup must iterate `stream.getTracks()` and call `.stop()` per-track, on both the happy path AND every error/cancel path.
- **`String.fromCharCode(...bytes)` blows the stack on large buffers** — the spread operator pushes every byte as an argument. Chunk in 0x8000-byte slices when converting audio `ArrayBuffer` → base64.
- **Gemini transcription: dummy API key returns HTTP 400** (not 500) — the SDK propagates the upstream 400 verbatim. Integration tests that expect "validation passed → request reached Gemini" must check the error *message*, not just the status code, because both "our allowlist rejected this" and "upstream key invalid" return 400.
- **Nitro WS requires `nitro.experimental.websocket: true`** — set it in `nuxt.config.ts`. Without the flag, `defineEventHandler({ websocket })` silently ignores the hooks and falls through to the HTTP handler. Adding a new WS route needs a server restart; HMR doesn't re-register the experimental feature.
- **crossws upgrade hook must RETURN `void`, not an object with `{ context }`** — the return type is `Response | ResponseInit | void`. An object with a non-ResponseInit shape is silently treated as a bad ResponseInit and corrupts the handshake with an ECONNRESET that crashes the Nitro worker. Mutate `request.context` in-place instead.
- **crossws + Node `ws` delivers text frames as Buffer** — `typeof message.rawData === 'string'` is unreliable. To distinguish text control frames from binary audio: peek the first byte for `{` (0x7B), then try `JSON.parse(message.text())`, then whitelist by `type`. See `tryParseControl` in `server/utils/agentic/dictateHelpers.ts`.
- **`useWebSocket` has TWO independent flags: `immediate` AND `autoConnect`** — both default to `true`. `immediate: false` alone still leaves `autoConnect: true`, which WATCHES the URL ref and opens a socket on change. Combined with an explicit `.open()` call, that spawns TWO sockets per action. Set both `immediate: false, autoConnect: false` when you want manual lifecycle control.
- **`@google-cloud/speech` streaming: `stream.write(buf)` NOT `stream.write({ audioContent: buf })`** — the helper's internal PassThrough wraps each raw Buffer as `{ audioContent }` before forwarding to gRPC. Wrapping it yourself produces `{ audioContent: { audioContent: Buffer } }` which Google rejects with "Expected audio_content none was set". The README example showing `stream.write(request)` is wrong/outdated; the authoritative pattern is in the package's `system-test/speech_system_test_v1.js` — pipe raw audio in.
- **`@google-cloud/speech` SpeechClient `apiKey` option isn't in the TS types** — needs `@ts-expect-error` but works at runtime via google-auth-library. Upstream types are incomplete.
- **Cloud STT v1 sync `recognize` doesn't accept MP4/AAC** — only `WEBM_OPUS`, `OGG_OPUS`, `LINEAR16`, `FLAC`, `MULAW`, `AMR`, `AMR_WB`. Safari's MediaRecorder default (`audio/mp4`) is rejected. Either transcode server-side or route Safari through the batch Files API which does accept MP4.
- **Cloud STT model names:** v1 has `latest_long` (dictation-tuned) and `latest_short` (for short utterances — chops long dictation). `chirp_2` is v2-ONLY and requires a project id in the recognizer path; not usable with v1 sync via API key.
- **`tryAcquireSessionLock` fails CLOSED, `consumeRateLimitBudget` fails OPEN** — opposite polarity by design. The lock is a correctness cap (fail-open would let unlimited concurrent sessions through and double-bill GCP); the budget is a DoS limit (fail-open prevents a wedged Valkey from DoS'ing the app). Don't accidentally flip either.
- **`consumeRateLimitBudget` with `cost: 0` must PEEK the actual remaining** — used at session-open time. Earlier version returned `maxCost` unconditionally which let exhausted users open a session only to trip on the first chunk (open-then-close flicker). The peek path now reads the bucket without touching it.
- **Dictation WS auth via FIRST MESSAGE, not `?token=`** — the query string leaks into access logs, referer headers, and browser history. Server's `upgrade` hook is empty (accepts all); the `open` hook arms a 5s deadline, the `message` hook rejects non-`auth` frames until authed. Pre-auth binary is also rejected (malicious clients shipping audio before auth).
- **Dictation straggler-chunk guard:** after `ctx.stt.end()`, audio chunks already queued by the browser's AudioWorklet → postMessage → WS pipeline arrive post-end. `ctx.sttEnded` flag drops them at the peer's `message` handler; a second defense in the stream error listener silently swallows "write after end" errors when the flag is set. Without either, `stop` → "error: write after end" UI toast.
- **Gemini JS SDK `embedContent([str, str, …])` returns ONE vector, not N** — the SDK treats the array as a multi-part Content. Loop per-chunk with bounded concurrency (`server/utils/embeddings.ts`). Python SDK does per-string; don't port Python patterns blindly. Symptom: `[embeddings] expected N vectors, got 1` flipping the row to `failed`.
- **Drizzle doesn't emit `CREATE EXTENSION vector`** — when `generate` produces a migration with a `vector(…)` column, hand-prepend `CREATE EXTENSION IF NOT EXISTS vector;` + `statement-breakpoint`. Without it the migration fails on a fresh DB with "type vector does not exist".
- **pgvector HNSW caps at 2000 dims** — 3072-d (Gemini's full `gemini-embedding-2-preview`) can't use HNSW; must use IVFFlat or drop to 768/1536 via MRL. We pick 768 for HNSW compat + cost.
- **`websearch_to_tsquery` on stopword-only input returns empty tsquery** — the `@@` predicate then returns zero rows. Our hybrid search degrades to vector-only in that case rather than erroring; don't add a guard that short-circuits on empty queries or you lose useful signal on single-keyword searches.
- **Advisory locks must be INSIDE a txn** — `pg_advisory_xact_lock(hashtext(...))` only releases on COMMIT/ROLLBACK. Outside a transaction it would pin a connection. All knowledge-confirm writes go through `db.transaction(async tx => ...)` so the lock scope is explicit.
- **Valkey inflight counter fails CLOSED** — if Valkey is down, `reserveInflightSlot` returns `allowed: false`. Trade-off: we'd rather reject uploads on Valkey outage than let uncapped concurrent uploads through. The DB-count cap is still there as a second line, but the race window without the inflight counter is real.
- **`file-type` returns undefined on plain-text input** — no magic bytes for MD/TXT/HTML. The guard falls through to a printable-UTF-8 ratio check on the first 1 KB. Don't treat `undefined` as "unknown format = allow"; that's an allowlist bypass.
- **Knowledge S3 original is deleted after processing** — `deleteKnowledgeArtifact` still tries to delete on row-delete, tolerating 404. Don't assume `workspace_knowledge.s3_key` points at a live object for `ready` rows; it's historical after processing.
- **processKnowledge re-checks row existence after conversion AND after embedding** — user can delete mid-pipeline; without the re-check we'd waste Gemini embedding calls on a doomed insert. Added after we caught it wasting a 160-chunk embedding run on a deleted row.
- **AI must end every turn with `insert_text`/`replace_text`** — there's no chat surface for model prose. System prompt makes this explicit + bans clarifying questions. If you ever add a chat view, rewrite the "no chat UI" block in `server/api/ai/prompt.post.ts` or the model will still hide its work in edits.
- **Knowledge tools are in a SEPARATE declaration array** — `KNOWLEDGE_TOOL_DECLARATIONS` is concatenated to `ALL_TOOL_DECLARATIONS` only when the session has workspace access AND ≥1 ready file. The `TOOL_SCHEMAS` drift guard test checks the UNION of both arrays — if you move a knowledge tool into `ALL_*`, update the test and the `hasKnowledgeAccess` gate in `prompt.post.ts`.
- **`bun run test:coverage` undercounts.** `@vitest/coverage-v8` only measures code that executes inside the vitest process (unit + repos + nuxt projects). Integration tests spawn a separate `bun run dev` subprocess via `tests/integration/setup/server.ts`, and every `server/api/*`, `server/middleware/*`, `server/plugins/*`, `server/routes/*` runs inside THAT process — invisible to coverage. So a file reading 0% in the report doesn't mean it's untested; it means it's only exercised via the subprocess. Three dead ends worth documenting so we don't try again: (1) Bun doesn't honor `NODE_V8_COVERAGE` (oven-sh/bun#17867, open since March 2025) — verified empirically, Bun writes nothing. (2) Spawning the subprocess with `node` instead of `bun` + NODE_V8_COVERAGE DOES produce coverage files, but Nitro dev runs every server-side file through Vite's SSR transform and evaluates via `vm.Script`; Node records those as URL `evalmachine.<anonymous>`, which c8 can't map back to source paths. Only `shared/config/tiers.ts` shows up (it's imported by nuxt.config.ts at boot before Vite intercepts). (3) `@nuxt/test-utils/e2e` `setup()` spawns `node .output/server/index.mjs` which WOULD produce coverage with real source maps — but our `nitro.preset: 'bun'` build traces Bun-specific paths and Stripe's ESM entry doesn't resolve under Node's ESM resolver (`Cannot find module .output/server/node_modules/stripe/esm/stripe.esm.node.js`). Switching to `preset: 'node-server'` risks the lib0 conditional-exports breakage that forced us onto the Bun preset in the first place. **Net conclusion: the API-route coverage gap is architectural, not fixable with the current stack choices.** When reviewing `bun run test:coverage` output, mentally overlay: every `server/api/*`, `server/middleware/*`, `server/plugins/*`, `server/routes/*`, plus some orchestrators like `processKnowledge.ts` and `aiClient.ts`, is covered by the 300+ integration tests in `tests/integration/` — they just don't show up in the number.

### Flow docs system gotchas

- **`docker compose down --remove-orphans` is a footgun in this project.** All compose files share the same project namespace (`md-online`), so `--remove-orphans` treats services from OTHER compose files as orphans and removes them. `bun run flows:down` and `scripts/flows-ephemeral.ts` deliberately do NOT use `--remove-orphans`. Add it back and you'll wipe dev infra on every flow-test run.
- **Caption inversion bug from SPA navigation.** A click that triggers `router.push()` keeps the OS cursor at the click coordinates AND keeps the same JS context (no full page reload), so `window.__flowCursor` still holds the click target's coordinates — but those coordinates were valid on page A's layout, not page B's. Without the URL-stamp guard in the cursor injection script (`__flowCursorPath`), the post-nav screenshot floats the cursor in random space on the destination page. The injection script now stamps `location.pathname` on every motion; `readCursor` returns null when the path has changed since.
- **Use `flow.click(caption, locator)` for navigation clicks**, NOT `flow.step('Click X', () => locator.click())`. The latter captures AFTER the click — the screenshot lands on the destination page with no meaningful cursor (after the URL-stamp fix above). `flow.click` hovers FIRST, screenshots WITH the cursor on the target, THEN clicks. The "Click X" caption now actually shows the click happening on the page where it makes sense.
- **`<ContentRenderer>` wraps its output in an unstyled `<div>`.** A `.docs-article > *` rule targets the wrapper, not the actual content children. The fix: pass `class="docs-content"` to `<ContentRenderer>` so the wrapper carries the grid styles directly. The Tailwind `:deep(> *)` selector then reaches the real children.
- **SSR `$fetch('/flows/...')` doesn't route through Vite's static handler in dev.** Nitro's internal route resolver in dev only knows about API routes; static assets in `public/` are served by Vite's middleware which `$fetch` bypasses on the server. The fix: prefix all manifest URLs with `useRequestURL().origin` so the request becomes a real HTTP fetch (which DOES hit Vite). Same code works on the client (`useRequestURL().origin` resolves to `window.location.origin`).
- **Nuxt color mode resolution order is fragile.** Setting `colorScheme` on the Playwright project (sets `prefers-color-scheme`) AND pre-seeding `nuxt-color-mode` localStorage via `addInitScript` together survive any change in @nuxtjs/color-mode's preference→value resolution. Using only one of the two has bitten us; belt + suspenders is the right call.
- **Nuxt devtools chrome shows up in screenshots if you don't strip it.** The floating "Nuxt" badge is `#nuxt-devtools-container` (note: NOT `#nuxt-devtools-anchor` which docs sometimes mention). The fixture injects `display: none !important` via `addInitScript`. Cheaper than disabling devtools globally.
- **Gemini JS SDK aside — `flow.click` opts must always pass a `Locator`, not a CSS selector string.** `page.locator(sel).first().hover()` works; `page.click(sel)` doesn't go through the same `Locator.hover()` path. Easy mistake to make.
- **Test title becomes the slug.** `'Quick share'` → `quick-share`. Used as both the on-disk directory name and the `<Flow id="...">` reference. Renaming a test = changing the URL of every page that embeds it. Set the test title carefully.
- **Stale test title = orphaned `public/flows/<old-slug>/`.** The build script does a clean rebuild so the old directory gets deleted next build — but until then, the old slug is still referenced by any docs page that hasn't been updated.
