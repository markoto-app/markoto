// Which personal access token created each MCP session.
//
// The MCP toolkit keeps its sessions (one McpServer + transport each) in
// the memory of the process that answered `initialize`; its tool list is
// fixed at that moment from the token's scopes. Without a binding, ANY
// valid token presented together with somebody's session id would be
// served by that session — a read-only token could reach write tools
// registered for a full-scope one. So:
//
//   - a session is only created after the token verified (middleware),
//   - its id is bound here to that token,
//   - every later request must present the SAME token (and the token is
//     re-verified per request, so revocation still bites immediately),
//   - per user, at most `MAX_SESSIONS_PER_USER` bound sessions: binding
//     one more drops that user's least recently used binding (its next
//     request gets "Session not found" and the client re-initializes).
//     Clients that re-initialize often are never locked out; how fast a
//     user can create sessions at all is rate-limited in `mcpGate.ts`.
//
// Process-local on purpose: the sessions themselves are process-local, so
// a binding can never be needed on an instance that doesn't hold the
// session. Entries idle longer than the toolkit's session lifetime are
// pruned.

export const MAX_SESSIONS_PER_USER = 20
/** Slightly longer than the toolkit's 30-min idle session lifetime. */
export const BINDING_IDLE_MS = 35 * 60_000

interface Binding {
  tokenId: string
  userId: number
  lastSeen: number
}

export type BindingCheck = 'ok' | 'unknown' | 'token-mismatch'

export class McpSessionBindings {
  private readonly bindings = new Map<string, Binding>()

  constructor(private readonly now: () => number = Date.now) {}

  bind(sessionId: string, tokenId: string, userId: number): void {
    this.prune()
    const own = [...this.bindings.entries()].filter(([, b]) => b.userId === userId)
    if (own.length >= MAX_SESSIONS_PER_USER) {
      own.sort((a, b) => a[1].lastSeen - b[1].lastSeen)
      for (const [id] of own.slice(0, own.length - MAX_SESSIONS_PER_USER + 1)) this.bindings.delete(id)
    }
    this.bindings.set(sessionId, { tokenId, userId, lastSeen: this.now() })
  }

  /** Verify `tokenId` is the token that created `sessionId`; refreshes the idle timer on success. */
  check(sessionId: string, tokenId: string): BindingCheck {
    const b = this.bindings.get(sessionId)
    if (!b || this.now() - b.lastSeen > BINDING_IDLE_MS) return 'unknown'
    if (b.tokenId !== tokenId) return 'token-mismatch'
    b.lastSeen = this.now()
    return 'ok'
  }

  /** Live sessions held by `userId` (after pruning idle ones). */
  countForUser(userId: number): number {
    this.prune()
    let n = 0
    for (const b of this.bindings.values()) if (b.userId === userId) n++
    return n
  }

  release(sessionId: string): void {
    this.bindings.delete(sessionId)
  }

  private prune(): void {
    const cutoff = this.now() - BINDING_IDLE_MS
    for (const [id, b] of this.bindings) {
      if (b.lastSeen < cutoff) this.bindings.delete(id)
    }
  }
}

let shared: McpSessionBindings | null = null

/** Process-wide binding table used by the `/mcp` middleware. */
export function useMcpSessionBindings(): McpSessionBindings {
  shared ??= new McpSessionBindings()
  return shared
}
