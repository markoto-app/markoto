# MCP server: agent rules

How the server works and how to add a tool: `docs/contributing/mcp.md`. Tool handlers are shared with the AI loop (`server/utils/agentic/AGENTS.md`).

- Never answer 401 from `/mcp`. MCP clients treat 401 as "start OAuth discovery", which markoto does not offer. Unauthenticated requests get a JSON-RPC error with HTTP 403 (`jsonRpcErrorResponse` in `lib/mcpGate.ts`).
- No toolkit session may exist before a token verified, and every session stays bound to the token that created it (`server/utils/mcp/mcpSessionBinding.ts`). Do not add a path that lets an unauthenticated `initialize` reach the toolkit.
- Re-check authorization on every call, inside the wrapper: the token's scope (`admitToolCall`) and the user's access to the document or workspace. A scope is necessary, never sufficient.
- Access failures answer 404 for both "missing" and "forbidden" (no enumeration). This also applies to token revocation.
- Do not fork tool logic into `server/mcp/`. Tools are thin wrappers that dispatch through the tool registry (`server/utils/ai/tools/registry.ts`: `executeFunctionByName`, `executeMetaTool`). MCP-only tools (`export_document_as_pdf`) are the exception. Where an MCP input field is the in-app tool's field unchanged, spread the tool's schema shape (`update_theme`, `web_search`, `export_document_as_markdown`); the MCP descriptions that differ are deliberate (they are written for MCP clients).
- Pick the builder by the tool's context: `doc` tools need `buildDocBoundTool`; `meta` tools use `buildWorkspaceBoundTool` or `buildUserOnlyTool`. The schema must include `doc_id` / `workspace_id` respectively (checked at module load).
- Wrappers must call `stripWrapperArgs` before dispatch; handlers expect the loop's argument shape, without `doc_id` / `workspace_id`.
- Every tool file needs an entry in `MCP_TOOL_CLASSES` (`lib/toolClasses.ts`); `tests/unit/mcp/mcpToolClasses.test.ts` fails otherwise. Cost-bearing tools are `cost` and get an extra limit in `admitToolCall`.
- `connectAsMcpClient` trusts its `docId`; check access before calling it.
- Keep the two identities in the MCP JWT apart: `userName: 'MCP'` is the display name; `userId: 'mcp:{mcpSessionId}'` is the principal the sync server writes into `activity_log.actor_principal`. Attribution joins on the principal.
- Pool keys are `(docId, principalId)`; never key on `docId` alone, or the loop and MCP sessions share awareness slots and JWT identities.
- Pass a token-minting function (not a fixed JWT) to `yDocPool.checkout` for connections that can outlive a token; the sync server closes connections whose token expires.
- The taint-and-confirm gate of the in-editor loop does not apply to MCP (decided: the client is the user's own agent and confirms tool calls in its own UI). Do not wire `crossBoundary.ts` into MCP.
- Rate limits use `checkRateLimit` and fail open; integration tests enforce them through `TEST_ENFORCE_RATE_LIMITS`. Add a new limit to `MCP_RATE_LIMITS` so the test suite covers it.
- Never log or return a token's plaintext or hash; plaintext is shown once at issue.
- Token CRUD (`server/api/mcp/tokens/`) is authenticated by the web session, never by a token.
- Multi-instance needs sticky routing for `/mcp`: the toolkit's sessions are per process even though the bindings are in Valkey.
