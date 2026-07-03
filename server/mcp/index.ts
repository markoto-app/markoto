import { verifyMcpPat, touchMcpSession, hashToken, extractMcpBearer, stashMcpClientInfo, drainMcpClientInfo, type McpAuthContext } from '../utils/mcpAuth'

// Default MCP handler. Soft-auth middleware: extract the bearer, verify
// against `mcp_personal_tokens`, and stash the resolved user + scopes on
// `event.context`. Per toolkit guidance we NEVER throw 401 from this
// middleware — clients interpret 401 on the MCP route as "this server
// requires OAuth discovery", which kicks them into a discovery flow we
// don't yet implement (PAT in v1, OAuth deferred to a later phase).
//
// Authentication failure simply leaves `event.context.mcp` undefined.
// Per-tool `enabled: event => Boolean(event.context.mcp)` guards then
// hide every tool from unauthenticated callers — they see an empty
// catalog instead of a 401 churn.
//
// Side-effect: every authenticated request also touches the
// `mcp_sessions` row (UPSERT, Valkey-throttled to 1/min) so
// `activity_log` rows tagged `mcp:{mcpSessionId}` can be joined back
// to the real human. Fire-and-forget — failure here is invisible to
// the caller, same polarity as `appendAuditEvent`.

declare module 'h3' {
  interface H3EventContext {
    /** MCP-PAT-resolved auth context. Undefined for unauthenticated requests. */
    mcp?: McpAuthContext
  }
}

export default defineMcpHandler({
  description: 'markoto — read, search, and edit your collaborative markdown documents.',
  middleware: async (event) => {
    const authHeader = getHeader(event, 'authorization')
    const ctx = await verifyMcpPat(authHeader)
    if (!ctx) return // anonymous — `enabled` guards hide every tool

    event.context.mcp = ctx

    const userAgent = getHeader(event, 'user-agent') ?? null

    // Peek the JSON-RPC body to (a) stash clientInfo.name on
    // `initialize` calls, and (b) detect `initialize` so we DON'T
    // also try to touchMcpSession (no session id has been assigned
    // yet — happens on the follow-up call). `readBody` caches the
    // parse so the toolkit's downstream handler doesn't re-read.
    let methodName: string | null = null
    try {
      const body = await readBody<{ method?: unknown, params?: { clientInfo?: { name?: unknown } } }>(event)
      if (body && typeof body.method === 'string') methodName = body.method
      if (methodName === 'initialize') {
        const clientName = body?.params?.clientInfo?.name
        if (typeof clientName === 'string' && clientName.trim().length > 0) {
          // Extract the plaintext to hash. `extractMcpBearer` returns
          // null if the header isn't a valid bearer — but we already
          // know ctx is set, so the header is valid.
          const plaintext = extractMcpBearer(authHeader)
          if (plaintext) {
            await stashMcpClientInfo(hashToken(plaintext), userAgent, clientName)
          }
        }
        // No mcp-session-id on initialize; nothing to touch yet.
        return
      }
    } catch {
      // Body-peek failure isn't fatal — fall through to the session
      // touch. The audit chain just won't get clientInfo.name from
      // this request. Common case: requests that aren't JSON-RPC
      // (notifications/initialized has a body too, but malformed
      // bodies shouldn't break auth).
    }

    // Session-id-carrying call (anything after initialize). Drain
    // the clientInfo stash if this is the first such call after
    // initialize; subsequent calls find an empty stash and pass
    // null, which `touchMcpSession`'s COALESCE-first-writer-wins
    // logic preserves the original client_name.
    const mcpSessionId = getHeader(event, 'mcp-session-id')
    if (mcpSessionId) {
      const plaintext = extractMcpBearer(authHeader)
      const clientName = plaintext
        ? await drainMcpClientInfo(hashToken(plaintext), userAgent)
        : null
      void touchMcpSession({
        mcpSessionId,
        userId: ctx.userId,
        tokenId: ctx.tokenId,
        clientName,
        userAgent
      })
    }
  }
})
