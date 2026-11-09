import type { McpAuthContext } from '../../utils/mcpAuth'
import type { BindingCheck, McpSessionBindings } from '../../utils/mcpSessionBinding'

// Request gate for `/mcp`, run by the handler middleware BEFORE the MCP
// toolkit sees the request (so before it can create a session):
//
//   1. per-client-address rate limit (also covers unauthenticated noise),
//   2. a valid personal access token is required — no token, no session.
//      The refusal is a JSON-RPC error with HTTP 403, never 401: MCP
//      clients treat 401 as "start OAuth discovery", which we don't offer,
//   3. per-token rate limit,
//   4. a request carrying `Mcp-Session-Id` must come with the token that
//      created that session (otherwise: "Session not found", like an
//      unknown id); a request without one may open a new session within
//      the per-user session-creation rate (the toolkit keeps a session for
//      30 idle minutes in a table shared by everybody, so this bounds what
//      one account can occupy; `McpSessionBindings` additionally keeps at
//      most 20 usable sessions per user). The bindings live in Valkey;
//      a lookup that fails counts as "no binding" (fail closed).
//
// Pure decision logic with injected dependencies (unit-tested); the
// middleware in `server/mcp/index.ts` wires the real ones.

export interface RateLimitRule {
  namespace: string
  max: number
  windowMs: number
}

export const MCP_RATE_LIMITS = {
  /** Every request to /mcp per client address. */
  perClient: { namespace: 'mcp-client', max: 300, windowMs: 60_000 },
  /** Every request per token. */
  perToken: { namespace: 'mcp-token', max: 240, windowMs: 60_000 },
  /** New sessions (`initialize` without a session id) per user. */
  sessionsPerUser: { namespace: 'mcp-session-user', max: 60, windowMs: 60 * 60_000 },
  /** Tool calls per user, across all their tokens and sessions. */
  toolCallsPerUser: { namespace: 'mcp-tool-user', max: 120, windowMs: 60_000 },
  /**
   * Tool calls per user per day — only enforced when the plan sets
   * `mcpToolCallsPerDay` (the plan's number replaces `max`).
   */
  toolCallsPerUserDaily: { namespace: 'mcp-tool-user-day', max: 0, windowMs: 24 * 60 * 60_000 },
  /** `generate_image` per user (each call costs a paid image generation). */
  generateImagePerUser: { namespace: 'mcp-generate-image', max: 20, windowMs: 60 * 60_000 }
} as const satisfies Record<string, RateLimitRule>

export interface McpGateDeps {
  verifyToken(authHeader: string | undefined): Promise<McpAuthContext | null>
  rateLimit(rule: RateLimitRule, key: string): Promise<boolean>
  bindings: McpSessionBindings
}

export interface McpGateInput {
  authHeader: string | undefined
  /** Rate-limit key of the client address. */
  clientKey: string
  /** `Mcp-Session-Id` header, if any. */
  sessionId: string | null
}

export type McpGateDecision
  = | { kind: 'reject', status: number, rpcCode: number, message: string }
    | { kind: 'proceed', auth: McpAuthContext, opensSession: boolean }

export async function evaluateMcpRequest(input: McpGateInput, deps: McpGateDeps): Promise<McpGateDecision> {
  if (!(await deps.rateLimit(MCP_RATE_LIMITS.perClient, input.clientKey))) {
    return { kind: 'reject', status: 429, rpcCode: -32000, message: 'Too many requests. Try again in a minute.' }
  }
  const auth = await deps.verifyToken(input.authHeader)
  if (!auth) {
    return {
      kind: 'reject',
      status: 403,
      rpcCode: -32001,
      message: 'Authentication required: send "Authorization: Bearer <markoto personal access token>". Create a token under Settings → Integrations.'
    }
  }
  if (!(await deps.rateLimit(MCP_RATE_LIMITS.perToken, auth.tokenId))) {
    return { kind: 'reject', status: 429, rpcCode: -32000, message: 'Too many requests for this token. Try again in a minute.' }
  }
  if (input.sessionId) {
    // Unknown and foreign sessions get the same answer as the toolkit's
    // own "unknown session" — no hint that the id exists.
    if (await checkBinding(deps.bindings, input.sessionId, auth.tokenId) !== 'ok') {
      return { kind: 'reject', status: 404, rpcCode: -32001, message: 'Session not found' }
    }
    return { kind: 'proceed', auth, opensSession: false }
  }
  if (!(await deps.rateLimit(MCP_RATE_LIMITS.sessionsPerUser, String(auth.userId)))) {
    return { kind: 'reject', status: 429, rpcCode: -32000, message: 'Too many new MCP sessions. Reuse your client\'s session or try again later.' }
  }
  return { kind: 'proceed', auth, opensSession: true }
}

/** Binding lookup; a storage error refuses the session (fail closed). */
async function checkBinding(bindings: McpSessionBindings, sessionId: string, tokenId: string): Promise<BindingCheck> {
  try {
    return await bindings.check(sessionId, tokenId)
  } catch (e) {
    console.warn(`[mcp] session binding lookup failed: ${e instanceof Error ? e.message : String(e)}`)
    return 'unknown'
  }
}

/** JSON-RPC error envelope as an HTTP response (the toolkit's own error shape). */
export function jsonRpcErrorResponse(status: number, rpcCode: number, message: string): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (status === 429) headers['Retry-After'] = '60'
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: rpcCode, message }, id: null }), { status, headers })
}
