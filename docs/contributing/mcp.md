# The MCP server

markoto exposes its document tools to external MCP clients (Claude Desktop, Cursor, scripts) at `/mcp`. The server is built on `@nuxtjs/mcp-toolkit` (configured in `nuxt.config.ts`, `mcp` block) and runs the same tool handlers as the in-editor AI loop ([ai-tools.md](ai-tools.md)). An MCP edit is a live Y.js edit: collaborators see it arrive, and the activity row traces back to the person behind the token.

## Files

| Path | Role |
|---|---|
| `server/mcp/index.ts` | The MCP handler and its middleware (rate limits, token check, session binding, `mcp_sessions` row) |
| `server/mcp/lib/mcpGate.ts` | `evaluateMcpRequest` (the middleware's pure decision logic) and `MCP_RATE_LIMITS` |
| `server/mcp/lib/wrapDocBoundTool.ts` | The three tool builders and `admitToolCall` (per-call checks) |
| `server/mcp/lib/toolClasses.ts` | Plan class (`read` / `write` / `cost`) of every tool |
| `server/mcp/lib/stripWrapperArgs.ts` | Removes the wrapper's `doc_id` / `workspace_id` before dispatch |
| `server/mcp/tools/*.ts` | One file per tool; the toolkit discovers them |
| `server/utils/mcp/mcpAuth.ts` | Personal access tokens: create, hash, verify, revoke; `mcp_sessions` touch |
| `server/utils/mcp/mcpSessionBinding.ts` | Session-to-token binding in Valkey |
| `server/utils/mcp/mcpHocuspocusClient.ts` | `connectAsMcpClient`: connects to a document and builds the tool context |
| `server/utils/mcp/yDocPool.ts` | Hocuspocus provider pool shared by MCP and the AI loop |
| `server/utils/ai/tools/registry.ts` | The tool registry both callers use (`executeFunctionByName`, `executeMetaTool`; `MetaToolName` types the workspace- and user-bound builders) |
| `server/api/mcp/tokens/` | List, issue and revoke tokens (signed-in web session, not a token) |

## Request lifecycle

1. **Middleware** (`server/mcp/index.ts`, before the toolkit):
   - rate limit per client address (`mcp-client`, 300 per minute);
   - `Authorization: Bearer mkt_…` must verify. Otherwise the answer is a JSON-RPC error with HTTP 403 and no session is created. Never 401: MCP clients treat 401 as "start OAuth discovery", which markoto does not offer;
   - rate limit per token (`mcp-token`, 240 per minute);
   - a request with `Mcp-Session-Id` must use the token that created the session, otherwise 404 "Session not found";
   - a request without one may open a session (`mcp-session-user`, 60 per hour). At most `MAX_SESSIONS_PER_USER` (20) stay bound per user; binding another drops the least recently used. After the toolkit answers, the new session id is bound to the token and the `mcp_sessions` row is written with the client's `clientInfo.name`.
2. **Tool call**: the tool's `enabled` guard hides it at `initialize` when the token lacks the scope or the plan lacks the class. `admitToolCall` re-checks the scope on every call, counts the per-user limit (`mcp-tool-user`, 120 per minute) and the tool's extra limit (render tools share the PDF download allowance; `generate_image` 20 per user per hour), then the builder checks the user's access to the document or workspace, builds the context, dispatches, and cleans up.

All limits are Valkey sliding windows (`checkRateLimit`). They fail open on Valkey errors and are bypassed in test mode unless named in `TEST_ENFORCE_RATE_LIMITS`; `tests/integration/mcp/rateLimits.test.ts` drives each one.

The taint-and-confirm gate of the in-editor loop does not apply to MCP. The client is the user's own agent, shows its tool calls to the user, and runs within scopes the user chose; markoto has no UI inside the client to ask in. Every call still stays inside the token's scopes and the user's access.

## Tokens and scopes

- Token format: `mkt_` plus 32 base32 characters. Only the SHA-256 hash is stored (`mcp_personal_tokens`); the plaintext is shown once at issue. The prefix makes leaked tokens easy to search for.
- Scopes (`MCP_SCOPES` in `mcpAuth.ts`): `documents:read`, `documents:write`, `knowledge:read`, `web:fetch`. `generate_image` needs `documents:write`.
- `verifyMcpPat` caches successful lookups in Valkey for 60 seconds; misses are not cached. Revoking (`DELETE /api/mcp/tokens/:tokenId`) sets `revoked_at`, clears the cache entry and drops the token's session bindings. A foreign or already revoked token id gets 404.
- Tokens are managed in the web app (`app/pages/settings/integrations.vue`); issue and revoke write `mcp.token_issued` / `mcp.token_revoked` audit events. At most `MAX_PATS_PER_USER` (20) active tokens per user.
- Plans without `mcpWrite` get a read-only server: only `read` tools are listed and callable. A plan's `mcpToolCallsPerDay` (none by default) caps calls per day.

## Tool builders

| Builder | Argument added | Context | Handlers allowed |
|---|---|---|---|
| `buildDocBoundTool` | `doc_id` | `DocToolContext` from `connectAsMcpClient` (live Y.js handles) | document and meta handlers |
| `buildWorkspaceBoundTool` | `workspace_id` | `MetaToolContext`, membership checked against `minRole` | meta handlers only |
| `buildUserOnlyTool` | none | `MetaToolContext` for the user's own data | meta handlers only |

Wrapping a document handler in a workspace or user builder is a type error. Access failures answer 404 for both "missing" and "forbidden". The handler's result is converted to an MCP `CallToolResult`; image parts become image content blocks.

## Document connections and attribution

`yDocPool.ts` keys providers on `(docId, principalId)`. The AI loop uses `loop:{sessionId}` (a new entry per run); MCP uses `mcp:{mcpSessionId}`, so repeated calls in one client session reuse a warm connection. Entries close 5 minutes after their last release (`server/plugins/yDocPoolSweep.ts`). `connectAsMcpClient` passes a token-minting function, so a long-lived connection renews its 10-minute JWT when the sync server asks; it also limits a user to 10 open documents.

The MCP JWT carries `userName: 'MCP'` and `userId: 'mcp:{mcpSessionId}'`. The sync server writes the latter into `activity_log.actor_principal`, which joins back to the person and client:

```
activity_log.actor_principal = 'mcp:<sid>'
  → mcp_sessions.mcp_session_id = <sid>
    → user_id (the person), client_name, token_id (the credential)
```

`listRecentActivity` (`server/repos/activity.ts`) resolves these for the activity feed; AI-loop rows (`ai:assistant:…`) use the same column. `server/plugins/mcp-sessions-sweep.ts` deletes `mcp_sessions` rows idle for more than 90 days.

## Adding a tool

1. Add the handler to the loop first ([ai-tools.md](ai-tools.md)), unless the tool is MCP-only like `export_document_as_pdf`.
2. Create `server/mcp/tools/<name>.ts` with the builder that matches the handler's table. The schema must include `doc_id` (document builder) or `workspace_id` (workspace builder); this is asserted at module load. Set `scope`, `access` and MCP `annotations`.
3. Add the tool to `MCP_TOOL_CLASSES` in `server/mcp/lib/toolClasses.ts`; `tests/unit/mcp/mcpToolClasses.test.ts` fails without it. An unlisted tool counts as `write`.
4. If it costs platform money or renderer time, give it an extra limit through `admitToolCall`.

The section tools of the loop have wrappers ([ai-tools.md](ai-tools.md), "Long documents: sections"): `outline`, `read_section` and `search_document` (class `read`, `documents:read`), `replace_section`, `insert_markdown`, `move_section`, `swap_sections`, `delete_section`, `set_heading`, `renumber_headings`, `replace_all` and `edit_lines` (class `write`). They spread the in-app argument schema plus `doc_id`. Section ids (`s-12`) live on the pooled connection of the MCP session (`mcp:{mcpSessionId}`), so ids from one `outline` call stay valid for later calls in the same MCP session, and are unknown in a new one.

Not every loop tool has a wrapper. `load_skill` has none (an MCP client brings its own instructions). `delegate_scan` and `delegate_rewrite` (delegated jobs, `server/utils/ai/jobs/`) stay in-app for now: an MCP client is its own planner and can call the section tools itself, a job's cost confirmation goes through the prompt bar (MCP has no channel to ask the person), and a job outlives the call that started it, which the MCP tool shape has no way to report. A later version may offer them as a `cost`-class tool with an explicit budget argument.

## Limits of the current design

The session bindings live in Valkey, but the toolkit's own sessions are per process. Running several app instances needs sticky routing for `/mcp` (or a shared toolkit session store). MCP tool calls have no abort signal; web tools rely on upstream timeouts.
