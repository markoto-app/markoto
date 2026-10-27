# MCP Server — external AI clients over the doc-tool surface

Exposes markoto's document tools to external MCP clients (Claude Desktop, Cursor, the ChatGPT app store, ad-hoc scripts) at **`/mcp`** via JSON-RPC, using the SAME tool implementations as the in-app agentic loop. Built on **`@nuxtjs/mcp-toolkit`** (`nuxt.config.ts` → `modules` + the `mcp: {...}` block). Auth is **Personal Access Token (PAT)** based in v1; OAuth discovery is deferred to a later phase.

The headline promise: an MCP tool call edits the live Y.Doc exactly like the AI-as-Y.js-client path — collaborators watch the edit land in real time, and the activity row is attributable back to the human behind the token.

For the in-app AI loop these tools originally served, see `server/utils/agentic/AGENTS.md`. This doc covers only the MCP delivery layer.

---

## Layout

| Path | Role |
|---|---|
| `index.ts` | The default MCP handler. Gate middleware (`lib/mcpGate.ts`): rate limits, PAT required (403 JSON-RPC error otherwise — no session for anonymous callers), session ↔ token binding, `mcp_sessions` row. |
| `tools/*.ts` | One file per tool (28). Each is a ~10-line `buildDocBoundTool` / `buildWorkspaceBoundTool` / `buildUserOnlyTool` call — schema + scope + thin dispatch. Auto-discovered by the toolkit. |
| `lib/wrapDocBoundTool.ts` | The three wrapper builders + `admitToolCall` (per-call scope re-check, per-user tool-call limit, optional render / image limit). Bake per-class boilerplate (scope guard, authz, context construction, dispatch, cleanup). |
| `lib/mcpGate.ts` | `evaluateMcpRequest` (pure decision logic for the middleware, unit-tested) + `MCP_RATE_LIMITS` + `jsonRpcErrorResponse`. |
| `lib/mcpToolContext.ts` | `hasScope(event, scope)` + `requireMcpAuth(event)` request helpers. |
| `lib/stripWrapperArgs.ts` | Removes wrapper-injected `doc_id` / `workspace_id` before dispatch (pure, unit-tested in isolation). |

**Shared with the loop** (live in `server/utils/`, NOT here):
- `utils/mcpAuth.ts` — PAT primitives (generate/hash/verify/revoke) + `mcp_sessions` touch.
- `utils/mcpSessionBinding.ts` — process-local `sessionId → {tokenId, userId}` table (the toolkit's sessions are process-local too) + per-user live-session count.
- `utils/renderRateLimit.ts` — the render allowance shared with `GET /api/docs/:id/pdf`.
- `utils/mcpHocuspocusClient.ts` — `connectAsMcpClient()`: the MCP equivalent of `createAiSession`, builds a `DocToolContext` backed by the pool.
- `utils/yDocPool.ts` — process-level `(docId, principalId)` HocuspocusProvider pool shared by BOTH the loop and MCP.
- `utils/agentic/toolContext.ts` — the `MetaToolContext` / `DocToolContext` split.
- `utils/agentic/toolHandlers.ts` — `DOC_TOOL_HANDLERS` / `META_TOOL_HANDLERS` dispatch tables (the one code path both callers share).
- `api/mcp/tokens/*` — REST CRUD for issuing / listing / revoking PATs (session-authed, NOT PAT-authed).

---

## Request lifecycle

1. **Middleware (`index.ts` → `lib/mcpGate.ts`)** — runs before the toolkit, so before it can create a session:
   - rate limit per client address (`mcp-client`, 300/min) — also bounds unauthenticated noise;
   - `Authorization: Bearer mkt_…` must verify (`verifyMcpPat`). Otherwise a JSON-RPC error with **HTTP 403** (`-32001`, "Authentication required …"). **Never 401** — clients interpret a 401 as "this server wants OAuth discovery" and kick into a flow we don't implement. Anonymous `initialize` calls used to create toolkit sessions (global cap 1000 per process, 30-min idle) and could lock everyone out; now they create nothing;
   - rate limit per token (`mcp-token`, 240/min);
   - a request WITH `Mcp-Session-Id` must present the token that created that session (`McpSessionBindings.check`) — any other token (same user or not) gets 404 "Session not found", like an unknown id;
   - a request WITHOUT one may open a session within the per-user creation rate (`mcp-session-user`, 60/hour — the toolkit keeps idle sessions 30 min in a table shared by everybody); at most `MAX_SESSIONS_PER_USER` (20) stay usable per user, binding one more drops that user's least recently used one (client re-initializes, never locked out). After the toolkit answered, the new id from the response header is bound to the token and the `mcp_sessions` row is written right away (`touchMcpSession` with `clientInfo.name` from the `initialize` body and the creating `token_id`).
2. **Session bookkeeping** — every later authenticated request touches the `mcp_sessions` row (`last_active_at`). Fire-and-forget, Valkey-throttled to 1/min/session. `client_name`, `user_agent` and `token_id` are first-writer-wins.
3. **Tool call** — the wrapper's `enabled` scope guard hides tools at `initialize` (the toolkit fixes a session's tool list then); the handler's `admitToolCall` re-checks the scope on EVERY call (missing → "Tool X not found"), applies the per-user tool-call limit (`mcp-tool-user`, 120/min) and the tool's extra limit (render tools: the shared `pdf-download` allowance, 10/client/min; `generate_image`: 20/user/hour), then authz-checks the doc/workspace against the PAT user, builds the right context, dispatches to `TOOL_HANDLERS[name]`, and cleans up in `finally`.

All rate limits are Valkey sliding windows (`checkRateLimit`): fail OPEN on Valkey errors and bypassed under `TEST_MODE` (so the integration suite can't exercise them — `tests/unit/mcpGate.test.ts` pins the decision logic).

**The taint + confirm gate of the in-editor loop (`server/utils/agentic/crossBoundary.ts`) does NOT apply to MCP — decided.** An MCP client is the user's own agent: the client shows each tool call to its user (most ask before running one), the user chose the token's scopes, and markoto has no UI inside the client to confirm in. Prompt injection inside the client's own model is the client's concern; markoto keeps every MCP call inside the token's scopes and the user's access (per-call authz below).

---

## Three tool classes (`lib/wrapDocBoundTool.ts`)

| Builder | Injected arg | Context built | Handler table |
|---|---|---|---|
| `buildDocBoundTool` | `doc_id` (required in schema) | `DocToolContext` via `connectAsMcpClient` — real Y.js handles, pool-backed | `TOOL_HANDLERS` (DOC + META) |
| `buildWorkspaceBoundTool` | `workspace_id` | `MetaToolContext` stub — no Y handles; membership-checked to `minRole` | `META_TOOL_HANDLERS` only (compile-enforced) |
| `buildUserOnlyTool` | none | `MetaToolContext` stub — user's own data (saved themes, my docs, web/url) | `META_TOOL_HANDLERS` only |

The **context-tier split is a type-level bug prevention**: `buildWorkspaceBoundTool({ name: 'replace_text' })` is a *compile error* because `replace_text` is keyed in `DOC_TOOL_HANDLERS` (needs `DocToolContext`), not `META_TOOL_HANDLERS`. See `toolContext.ts` header for the rationale — a META handler wrapped as doc-bound (or vice versa) can't typecheck.

**`stripWrapperArgs`**: the wrapper injects `doc_id` / `workspace_id` into the MCP tool schema (the client must name the doc), but the underlying handler expects the SAME args shape the in-app loop passes — which carries docId/workspaceId *out-of-band on the context*, never in args. Without the strip, spread-style handlers (`coerceThemePatch` in `update_theme`) leak the wrapper field into structural validators and get rejected. Fix once at the boundary, not N times per handler.

**Result translation** (`toolResultToCallToolResult`): the loop's `ToolResult` (`{content: string, isError, extraParts}`) → MCP's `CallToolResult` (`{content: ContentBlock[], ...}`). `extraParts` inlineData (from `view_image`) become MCP image content blocks; everything else stays text.

---

## YDocPool — where the pool actually pays off

`utils/yDocPool.ts` keys on `(docId, principalId)`:
- In-app loop → principal `loop:{loopSessionId}` (unique per run — no cache hits, just a clean API boundary).
- MCP → principal `mcp:{mcpSessionId}` (**stable across a client's whole conversation** — repeated `view_document` / `replace_text` calls on the same doc reuse ONE warm provider, saving the ~200-500 ms handshake each). Eviction 5 min after `refCount` hits 0.

The `(docId, principalId)` key (not docId-alone) avoids **awareness contention** (each principal owns its `mcpStatus`/`aiStatus` awareness slot) and **JWT identity collision** (loop uses `ai:assistant:{sid}`, MCP uses `mcp:{sid}` → different JWTs → different providers). Concurrent checkouts of the same key dedupe via an in-flight `Map`. Idle eviction runs in `server/plugins/yDocPoolSweep.ts` (60s tick, 5-min idle, process-local — no advisory lock, each Nuxt process owns its own connections).

`connectAsMcpClient` mints a **10-min doc-scoped JWT** with `userName: 'MCP'` and a synthetic principal `mcp:{mcpSessionId}` carried in the JWT `userId` — the sync-server writes that into `activity_log.actor_principal`. The JWT TTL and the pool-entry lifecycle are independent (eviction is refCount-based, not expiry-based; a tool call past JWT expiry re-mints via a fresh checkout).

---

## Data model

| Table | Purpose |
|---|---|
| `mcp_personal_tokens` | Hashed PATs. `token_id` (`mkt_pat_<nanoid>`, public), `token_hash` (SHA-256 of `mkt_<32-char-base32>` plaintext, unique), `scopes` (text[]), `last_used_at`, `revoked_at` (soft-delete), `expires_at` (null in v1). FK `user_id` cascades. Migration `0015`. |
| `mcp_sessions` | One row per client connection. `mcp_session_id` (unique, from the toolkit), `user_id`, `token_id` (FK, `SET NULL`), `client_name`, `user_agent`, `last_active_at`. Migration `0016`. |
| `activity_log.actor_principal` | Nullable text + partial index (`WHERE actor_principal IS NOT NULL`). Structured agent-attribution field. Migration `0017`. |

**Token shape**: `mkt_<32-char-base32>` (160 bits from `crypto.randomBytes`). The `mkt_` prefix makes leaks greppable (GitHub's `ghp_` trick). Only the SHA-256 hash is stored; plaintext is returned **exactly once** at issuance and never reconstructed. Scopes: `documents:read`, `documents:write`, `knowledge:read`, `web:fetch` (`web_search`, `fetch_url`). `generate_image` requires **`documents:write`** (it writes an asset into a document and spends the user's AI budget); until the security fix it was under `web:fetch`. No data migration: new tokens get all four scopes, so tokens issued from the UI already carry `documents:write`; a token with `web:fetch` but without `documents:write` (only possible via a hand-written scope list) simply no longer lists `generate_image` — re-issue it with write access if wanted.

**Attribution chain** (the whole point of `actor_principal` + `mcp_sessions`; verified end-to-end by `tests/integration/mcp/audit-and-session.test.ts`):

```
activity_log.actor_principal LIKE 'mcp:%'
  → strip 'mcp:' → mcp_sessions.mcp_session_id
    → mcp_sessions.user_id     → users (the human)
    → mcp_sessions.client_name (e.g. 'Claude Desktop')
    → mcp_sessions.token_id    → mcp_personal_tokens (which credential)
```

The same column also serves `ai:assistant:%` (loop → `ai_sessions`). `server/repos/activity.ts`'s `listRecentActivity` runs `enrichActivityAgentFields` to resolve the principal → session → human for the `ActivityFeed.vue` render. Before this column, agent rows hardcoded `userName='AI Assistant'` with no traceback; the structured field lets MCP join through the same render layer without polluting `user_name`.

---

## Auth & scopes

- **Verify hot path** (`verifyMcpPat`) is Valkey read-through cached 60s, keyed on the token hash. **Positive hits only** — misses aren't cached so a fresh token lights up immediately and a brute-forcer gets no free cache hits. Cache/DB miss, `revoked_at != null`, and past-`expires_at` all return null → soft-fail. `last_used_at` bump is throttled 1/min via a separate Valkey key (hot-row protection).
- **Revocation** (`DELETE /api/mcp/tokens/:tokenId`) soft-deletes (`revoked_at`) and calls `invalidateMcpPatCache(hash)` so the 60s cache doesn't keep accepting it. 404 (not 403) for a foreign/already-revoked token id — anti-enumeration.
- **Scope guard**: `enabled: event => hasScope(event, scope)` hides the tool from `tools/list` at `initialize`; `admitToolCall` re-checks on every call. Sessions are bound to their creating token, so a session can't be reused with a narrower (or another user's) token.
- **Per-request authz** is ALWAYS re-checked against the PAT user inside the handler — `getDocAuthz` (doc-bound, 404-shape on both missing + forbidden) or `getMemberRole` vs `minRole` (workspace-bound, same 404-shape). The scope grant is necessary, not sufficient: a `documents:write` PAT still can't touch a doc the user can't edit.
- **Token CRUD endpoints** (`api/mcp/tokens/*`) are authed by the **normal Nitro session** (`requireValidatedUserSession`), NOT by a PAT — you manage tokens from the logged-in web UI (`app/pages/settings/integrations.vue`). Issue + revoke emit `mcp.token_issued` / `mcp.token_revoked` audit events (never logging the hash). Per-user cap: `MAX_PATS_PER_USER = 20` active.
- **Per-user open-doc cap**: `connectAsMcpClient` reserves a Valkey set slot (`MAX_OPEN_DOCS_PER_USER = 10`, 10-min TTL) before pool checkout; 429 over cap. Fails OPEN on Valkey error (anti-abuse, not correctness — matches `checkRateLimit` polarity).
- **Web-tool allowance**: `web_search` + `fetch_url` draw on the same per-user hourly/daily allowance as the in-app loop (`consumeWebToolQuota` in `server/utils/webTools.ts`, called inside `webSearch()` / `fetchUrl()`; 30/hour + 100/day by default, `NUXT_WEB_TOOLS_{HOURLY,DAILY}_LIMIT`). The upstream Staan/Jina call is platform-paid and never touches the user's LiteLLM budget; the synthesis runs on the caller's chat provider (BYOK → their own tokens). Over the limit → 429 `ai/web-tools-rate-limited`. The tools are not listed (`buildUserOnlyTool({ available })`) when the operator has no `STAAN_API_KEY` / `JINA_AI_API_KEY`. Fails OPEN on Valkey error.

---

## Sweepers

- `server/plugins/mcp-sessions-sweep.ts` — daily bulk-DELETE of `mcp_sessions` rows idle >90 days (mirrors the `processed_webhook_events` forensic window). Acquires `acquireSweepLock('mcp-sessions-sweep')` (cross-instance dedup) + `releaseSweepLock` in `finally`, like every other sweeper.
- `server/plugins/yDocPoolSweep.ts` — 60s tick, evicts pool entries idle >5 min. Process-local (no lock). `closeAll()` on the Nitro `close` hook so in-flight WS connections drain on shutdown.

---

## Key decisions

| Decision | Rationale |
|---|---|
| Never throw 401 from the MCP route | Clients treat 401 as "start OAuth discovery" — a flow we don't implement in v1. Unauthenticated callers get a 403 JSON-RPC error instead (no session created). |
| No session before authentication; session bound to its token | The toolkit's session table is global per process (max 1000); anonymous `initialize` filled it. The toolkit fixes a session's tools from the creating token's scopes, so without a binding any token holding the session id inherited them. |
| Keep toolkit sessions (not stateless mode) | `Mcp-Session-Id` is the YDocPool principal (`mcp:{sid}`) and the activity-attribution key; stateless mode would lose warm providers and the attribution join. |
| No taint/confirm gate for MCP | The client is the user's own agent and confirms tool calls in its own UI; see "Request lifecycle". |
| PAT (v1), OAuth deferred | PATs are a known, low-friction model (GitHub/npm). OAuth discovery is a bigger surface; the `mkt_` token + hashed-storage design is complete and shippable now. |
| Reuse loop tool handlers, don't fork | `toolHandlers.ts` (`DOC_/META_TOOL_HANDLERS`) is the single implementation. The MCP wrappers + the in-app loop both dispatch against it. Extracting this (with `toolContext.ts`, `toolHandlers.ts`, `createDocument.ts`) is why the feature diff also touched `aiClient.ts` / `aiToolAdapter.ts` / `functionTools.ts`. |
| Two-tier context (`Meta`/`Doc`) split | Makes "META handler wrapped as doc-bound" (and vice versa) a compile error. The wrapper builders type-constrain which names they accept. |
| `(docId, principalId)` pool key | docId-alone would collide awareness slots + JWT identities between the loop and MCP, and between two MCP sessions on the same doc. |
| Shared YDocPool for loop + MCP | One connection-lifecycle abstraction; the loop gets a clean boundary today and MCP gets warm-provider reuse across a conversation's tool calls. |
| `actor_principal` structured column (not `user_name` hack) | Gives every agent row a machine-joinable traceback to the human + client, shared by AI-loop and MCP rows, without polluting the display name. |
| Session-authed token CRUD; PAT-authed tool calls | You mint/revoke from the web UI (you're logged in); external clients present the PAT. Distinct auth surfaces on purpose. |

---

## Gotchas

- **`buildDocBoundTool` schemas MUST include `doc_id`; `buildWorkspaceBoundTool` MUST include `workspace_id`.** Asserted at module load (`assertSchemaContains`) — a missing field throws at boot, not at call time.
- **`stripWrapperArgs` must run before dispatch in every wrapper.** Forgetting it leaks `doc_id`/`workspace_id` into spread-style handlers (`update_theme`) and strict validators reject the merged result. Unit-pinned in isolation (`tests/unit/mcpWrapperShapeIsolation.test.ts`); wired-path pinned at the integration tier (`tests/integration/mcp/tools-write.test.ts` runs `update_theme` and asserts the merged theme persists).
- **Doc/workspace authz failures return 404, not 403** — anti-enumeration, matching the in-app endpoints. A forbidden doc and a non-existent doc are indistinguishable to the caller.
- **The middleware peeks the JSON-RPC body via `readBody`** (which caches the parse so the toolkit's downstream handler doesn't re-read) to take `clientInfo.name` from `initialize`; the session id comes from the toolkit's RESPONSE (`next()` returns the `Response`), so binding + row write happen after the toolkit answered and before the client can use the id.
- **`touchMcpSession` uses COALESCE-first-writer-wins** for `client_name`, `user_agent` AND `token_id` (the binding refuses any other token, so the creating credential is the one to record). Session-touch failure is Sentry-captured, never fatal — the tool call already authenticated.
- **The session binding is process-local** — exactly like the toolkit's sessions. A restart drops both; clients re-initialize.
- **`connectAsMcpClient` trusts its `docId`** — callers MUST authz-check before calling. The doc-bound wrapper does this via `assertDocAccess` and threads the resolved `workspaceId` through so `connectAsMcpClient` skips a second `getDoc`.
- **`mint`ed MCP JWT sets `userName: 'MCP'`** (the friendly `activity_log.user_name`); the join-able principal rides in the JWT `userId` field (`mcp:{sid}`), which the sync-server writes into `actor_principal`. Don't conflate the two.
- **MCP tool calls have no abort signal** — the loop's 5-min deadline has no MCP equivalent. `web_search`/`fetch_url` get a never-aborts signal and rely on the underlying Jina/Mistral SDK timeouts (`neverAbortSignal()` in `toolHandlers.ts`).
- **Multi-instance not wired yet.** Both the PAT verify cache and the YDocPool are process-aware but there's no in-memory PAT cache (if you add one, add a Valkey pub/sub invalidation broadcast — see `mcpAuth.ts` header) and no `app`-service sticky sessions (an MCP session split across two Nuxt containers pays the handshake twice; add `traefik...app.loadbalancer.sticky.cookie=true` when scaling out — see `yDocPool.ts` header). Single-instance today, so both are theoretical.
