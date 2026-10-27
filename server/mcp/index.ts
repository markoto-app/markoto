import { verifyMcpPat, touchMcpSession, type McpAuthContext } from '../utils/mcpAuth'
import { checkRateLimit } from '../utils/rateLimit'
import { getClientRateLimitKey } from '../utils/clientIp'
import { useMcpSessionBindings } from '../utils/mcpSessionBinding'
import { evaluateMcpRequest, jsonRpcErrorResponse } from './lib/mcpGate'

// Default MCP handler. The middleware is the gate in front of the MCP
// toolkit (`lib/mcpGate.ts` holds the decision logic):
//
//   - rate limits per client address and per token,
//   - a verified personal access token is REQUIRED. Without one the
//     request is refused with a JSON-RPC error (HTTP 403) before the
//     toolkit runs, so an anonymous `initialize` never creates a server
//     session (the toolkit keeps at most 1000 per process — anonymous
//     callers could otherwise exhaust them for everybody). Never 401:
//     MCP clients treat 401 as "start OAuth discovery", which we don't
//     offer,
//   - every request carrying `Mcp-Session-Id` must present the token
//     that created that session (`utils/mcpSessionBinding.ts`); per user
//     at most MAX_SESSIONS_PER_USER live sessions.
//
// Tools additionally re-check their scope and the user's access to the
// doc / workspace on every call (`lib/wrapDocBoundTool.ts`).
//
// Side-effect: authenticated requests touch the `mcp_sessions` row
// (UPSERT, Valkey-throttled to 1/min) so `activity_log` rows tagged
// `mcp:{mcpSessionId}` can be joined back to the real human. On
// `initialize` the row is written right away with the client's
// `clientInfo.name` and the creating token. Fire-and-forget — failure
// here is invisible to the caller, same polarity as `appendAuditEvent`.

declare module 'h3' {
  interface H3EventContext {
    /** MCP-PAT-resolved auth context. Set for every request that reaches the toolkit. */
    mcp?: McpAuthContext
  }
}

/** `clientInfo.name` from an `initialize` body, if this is one. */
async function initializeClientName(event: Parameters<typeof readBody>[0]): Promise<string | null> {
  try {
    const body: unknown = await readBody(event)
    if (typeof body !== 'object' || body === null) return null
    const rpc = body as Record<string, unknown>
    if (rpc.method !== 'initialize') return null
    const params = rpc.params
    if (typeof params !== 'object' || params === null) return null
    const clientInfo = (params as Record<string, unknown>).clientInfo
    if (typeof clientInfo !== 'object' || clientInfo === null) return null
    const name = (clientInfo as Record<string, unknown>).name
    return typeof name === 'string' && name.trim().length > 0 ? name.trim().slice(0, 200) : null
  } catch {
    // Not JSON-RPC (GET stream, malformed body) — nothing to record.
    return null
  }
}

export default defineMcpHandler({
  description: 'markoto — read, search, and edit your collaborative markdown documents.',
  middleware: async (event, next) => {
    const sessionHeader = getHeader(event, 'mcp-session-id')
    const bindings = useMcpSessionBindings()
    const decision = await evaluateMcpRequest(
      {
        authHeader: getHeader(event, 'authorization'),
        clientKey: getClientRateLimitKey(event),
        sessionId: typeof sessionHeader === 'string' && sessionHeader.length > 0 ? sessionHeader : null
      },
      {
        verifyToken: verifyMcpPat,
        rateLimit: (rule, key) => checkRateLimit(rule.namespace, key, rule.max, rule.windowMs),
        bindings
      }
    )
    if (decision.kind === 'reject') {
      return jsonRpcErrorResponse(decision.status, decision.rpcCode, decision.message)
    }

    const auth = decision.auth
    event.context.mcp = auth
    const userAgent = getHeader(event, 'user-agent') ?? null

    if (!decision.opensSession) {
      void touchMcpSession({
        mcpSessionId: String(sessionHeader),
        userId: auth.userId,
        tokenId: auth.tokenId,
        clientName: null,
        userAgent
      })
      return next()
    }

    // No session yet: let the toolkit answer (an `initialize` creates a
    // session and returns its id in `Mcp-Session-Id`), then bind that id
    // to this token before the client can use it.
    const clientName = await initializeClientName(event)
    const result = await next()
    const newSessionId = result.headers.get('mcp-session-id')
    if (newSessionId) {
      bindings.bind(newSessionId, auth.tokenId, auth.userId)
      void touchMcpSession({
        mcpSessionId: newSessionId,
        userId: auth.userId,
        tokenId: auth.tokenId,
        clientName,
        userAgent
      })
    }
    return result
  }
})
