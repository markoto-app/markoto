# MCP Server — external AI clients over the doc-tool surface

Exposes markoto's document tools to external MCP clients (Claude Desktop, Cursor, the ChatGPT app store, ad-hoc scripts) at **`/mcp`** via JSON-RPC, using the SAME tool implementations as the in-app agentic loop. Built on **`@nuxtjs/mcp-toolkit`** (`nuxt.config.ts` → `modules` + the `mcp: {...}` block). Auth is **Personal Access Token (PAT)** based in v1; OAuth discovery is deferred to a later phase.

The headline promise: an MCP tool call edits the live Y.Doc exactly like the AI-as-Y.js-client path — collaborators watch the edit land in real time, and the activity row is attributable back to the human behind the token.

For the in-app AI loop these tools originally served, see `server/utils/agentic/AGENTS.md`. This doc covers only the MCP delivery layer.

---

## Layout

| Path | Role |
|---|---|
| `index.ts` | The default MCP handler. Soft-auth middleware: verify the bearer PAT, stash `event.context.mcp`, touch the session row. |
| `tools/*.ts` | One file per tool (28). Each is a ~10-line `buildDocBoundTool` / `buildWorkspaceBoundTool` / `buildUserOnlyTool` call — schema + scope + thin dispatch. Auto-discovered by the toolkit. |
| `lib/wrapDocBoundTool.ts` | The three wrapper builders. Bake per-class boilerplate (scope guard, authz, context construction, dispatch, cleanup). |
| `lib/mcpToolContext.ts` | `hasScope(event, scope)` + `requireMcpAuth(event)` request helpers. |
| `lib/stripWrapperArgs.ts` | Removes wrapper-injected `doc_id` / `workspace_id` before dispatch (pure, unit-tested in isolation). |

**Shared with the loop** (live in `server/utils/`, NOT here):
- `utils/mcpAuth.ts` — PAT primitives (generate/hash/verify/revoke) + `mcp_sessions` touch + clientInfo stash.
- `utils/mcpHocuspocusClient.ts` — `connectAsMcpClient()`: the MCP equivalent of `createAiSession`, builds a `DocToolContext` backed by the pool.
- `utils/yDocPool.ts` — process-level `(docId, principalId)` HocuspocusProvider pool shared by BOTH the loop and MCP.
- `utils/agentic/toolContext.ts` — the `MetaToolContext` / `DocToolContext` split.
- `utils/agentic/toolHandlers.ts` — `DOC_TOOL_HANDLERS` / `META_TOOL_HANDLERS` dispatch tables (the one code path both callers share).
- `api/mcp/tokens/*` — REST CRUD for issuing / listing / revoking PATs (session-authed, NOT PAT-authed).

---

## Request lifecycle

1. **Middleware (`index.ts`)** — extract `Authorization: Bearer mkt_…`, `verifyMcpPat` it. On failure it just `return`s: `event.context.mcp` stays undefined. **We NEVER throw 401 from the MCP route** — clients interpret a 401 as "this server wants OAuth discovery" and kick into a flow we don't implement. Unauthenticated callers instead see an **empty tool catalog** because every tool's `enabled` guard returns false without a matching scope.
2. **Session bookkeeping** — the middleware peeks the JSON-RPC body. On `initialize` it stashes `clientInfo.name` ('Claude Desktop', 'Cursor') keyed on `(tokenHash, userAgent)` for 60s (no session id exists yet). On the first follow-up call carrying an `Mcp-Session-Id`, it drains the stash and `touchMcpSession` UPSERTs the `mcp_sessions` row. Fire-and-forget, Valkey-throttled to 1/min/session.
3. **Tool call** — the wrapper's `enabled` scope guard runs first (invisible tools for missing scopes), then the handler runs `requireMcpAuth`, authz-checks the doc/workspace against the PAT user, builds the right context, dispatches to `TOOL_HANDLERS[name]`, and cleans up in `finally`.

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

**Token shape**: `mkt_<32-char-base32>` (160 bits from `crypto.randomBytes`). The `mkt_` prefix makes leaks greppable (GitHub's `ghp_` trick). Only the SHA-256 hash is stored; plaintext is returned **exactly once** at issuance and never reconstructed. Scopes: `documents:read`, `documents:write`, `knowledge:read`, `web:fetch`.

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
- **Scope guard**: `enabled: event => hasScope(event, scope)`. Unauthenticated OR wrong-scope → the tool doesn't appear in `tools/list`.
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
| Never throw 401 from the MCP route | Clients treat 401 as "start OAuth discovery" — a flow we don't implement in v1. Soft-auth + `enabled` scope guards give unauthenticated callers an empty catalog instead of a discovery churn. |
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
- **The middleware peeks the JSON-RPC body via `readBody`** (which caches the parse so the toolkit's downstream handler doesn't re-read). `initialize` has no session id yet — that's why `clientInfo.name` is stashed on `(tokenHash, userAgent)` and drained on the next call.
- **`touchMcpSession` uses COALESCE-first-writer-wins** for `client_name`/`user_agent` (never overwrite a real value with null on later calls) but updates `token_id` unconditionally (a mid-session PAT rotation should be reflected). Session-touch failure is Sentry-captured, never fatal — the tool call already authenticated.
- **`connectAsMcpClient` trusts its `docId`** — callers MUST authz-check before calling. The doc-bound wrapper does this via `assertDocAccess` and threads the resolved `workspaceId` through so `connectAsMcpClient` skips a second `getDoc`.
- **`mint`ed MCP JWT sets `userName: 'MCP'`** (the friendly `activity_log.user_name`); the join-able principal rides in the JWT `userId` field (`mcp:{sid}`), which the sync-server writes into `actor_principal`. Don't conflate the two.
- **MCP tool calls have no abort signal** — the loop's 5-min deadline has no MCP equivalent. `web_search`/`fetch_url` get a never-aborts signal and rely on the underlying Jina/Mistral SDK timeouts (`neverAbortSignal()` in `toolHandlers.ts`).
- **Multi-instance not wired yet.** Both the PAT verify cache and the YDocPool are process-aware but there's no in-memory PAT cache (if you add one, add a Valkey pub/sub invalidation broadcast — see `mcpAuth.ts` header) and no `app`-service sticky sessions (an MCP session split across two Nuxt containers pays the handshake twice; add `traefik...app.loadbalancer.sticky.cookie=true` when scaling out — see `yDocPool.ts` header). Single-instance today, so both are theoretical.
