import type { H3Event } from 'h3'
import { hasScope as hasScopeRaw, type McpAuthContext, type McpScope } from '../../utils/mcp/mcpAuth'
import { mcpToolAllowed } from './toolClasses'

// Per-tool helpers shared by every wrapper in server/mcp/tools/*. Keeps
// the wrappers themselves to ~10 lines: schema + scope guard + thin
// handler call.

/** True iff the request's MCP context exists AND grants the scope. */
export function hasScope(event: H3Event, scope: McpScope): boolean {
  return hasScopeRaw(event.context.mcp?.scopes, scope)
}

/**
 * Tool visibility: the token grants the scope AND the owner's plan
 * includes the tool (read-only MCP without `mcpWrite`). Used as every
 * tool's `enabled` guard; `admitToolCall` re-checks both per call.
 */
export function toolEnabled(event: H3Event, scope: McpScope, name: string): boolean {
  return hasScope(event, scope) && mcpToolAllowed(name, event.context.mcpPlan?.mcpWrite ?? true)
}

/**
 * Resolve the authenticated user id from the MCP request, throwing a
 * tool-result-shaped error when the request was unauthenticated. Tools
 * SHOULD prefer `enabled: event => Boolean(event.context.mcp)` as the
 * primary gate (hides the tool entirely from unauthenticated callers);
 * this helper is the runtime fallback for the "tool was visible but the
 * context vanished mid-call" case (cache eviction, etc.).
 */
export function requireMcpAuth(event: H3Event): McpAuthContext {
  const ctx = event.context.mcp
  if (!ctx) {
    throw createError({
      statusCode: 401,
      message: 'MCP authentication required',
      data: { code: 'mcp/unauthenticated' }
    })
  }
  return ctx
}
