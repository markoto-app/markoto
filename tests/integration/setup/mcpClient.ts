import { nanoid } from 'nanoid'
import { TEST_BASE_URL } from './env'
import { testDb } from './db'
import { generateMcpToken, type McpScope } from '../../../server/utils/mcp/mcpAuth'

// Reusable MCP integration-test harness. Drives /mcp end-to-end against
// the running Nitro subprocess (started by globalSetup) using JSON-RPC.
//
// Why a custom client (not the official MCP SDK):
//   - The SDK ships its own transport + session-id assignment that
//     intercepts the JSON-RPC envelope. We want to assert the wire
//     shape, not exercise an SDK we don't ship.
//   - The toolkit's response Accept negotiation (`application/json,
//     text/event-stream`) means EVERY response can come back as either
//     SSE or plain JSON depending on session/tool — the harness
//     normalises both into one shape so tests don't care.
//
// PAT mint: tests don't go through `POST /api/mcp/tokens` (which needs
// a session cookie). `mintPat()` writes a row directly via `testDb()`
// using the same hash function the issuer uses (`generateMcpToken` ↦
// `hashToken`). Why direct insert instead of calling `issueMcpToken`:
// the issuer routes through `useDatabase()` which boots its own
// Drizzle pool from `DATABASE_URL` — unset in the test process (the
// integration env populates env vars only for the spawned Nitro
// subprocess), so the issuer would point at the wrong DB or fail.
// The HTTP endpoint shape is covered by `tests/integration/endpoints/`
// (separately) and the issuer's hash + lifecycle logic by
// `tests/repos/mcpAuth.test.ts`.

export interface MintPatInput {
  userId: number
  scopes: readonly McpScope[]
  /** Token name for `mcp_personal_tokens.name` audit column. */
  name?: string
  /** Optional expiry. Tests covering expiry pass a past Date. */
  expiresAt?: Date | null
}

export interface MintedPat {
  /** The plaintext bearer token — pass to `new McpClient(plaintext)`. */
  plaintext: string
  /** The opaque token id (mkt_pat_…) — useful for revoke-by-id assertions. */
  tokenId: string
}

/** Mint a Personal Access Token by inserting directly into
 *  `mcp_personal_tokens` via the test DB. Uses `generateMcpToken` to
 *  produce the plaintext + hash so the wire shape matches what the
 *  HTTP endpoint produces; only the DB-write path differs. */
export async function mintPat(input: MintPatInput): Promise<MintedPat> {
  const { plaintext, hash } = generateMcpToken()
  const tokenId = `mkt_pat_${nanoid(16)}`
  const db = testDb()
  await db.query(
    `INSERT INTO mcp_personal_tokens (token_id, user_id, name, token_hash, scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    // `scopes` is a Postgres text[] — pass a JS array; the pg driver
    // serialises it to native array syntax. Do NOT JSON.stringify here.
    [tokenId, input.userId, input.name ?? 'integration-test', hash, [...input.scopes], input.expiresAt ?? null]
  )
  return { plaintext, tokenId }
}

// ─── JSON-RPC client ─────────────────────────────────────────────────

export interface RpcResult<T = unknown> {
  result?: T
  error?: { code: number, message: string, data?: unknown }
}

export interface ToolListEntry {
  name: string
  title?: string
  description?: string
  inputSchema?: unknown
  annotations?: unknown
}

export interface CallToolResult {
  content: Array<
    | { type: 'text', text: string }
    | { type: 'image', data: string, mimeType: string }
    | { type: 'resource', resource: { uri: string, mimeType?: string, text?: string, blob?: string } }
  >
  /** Toolkit fills this when the handler returns `outputSchema` + `structuredContent`. */
  structuredContent?: unknown
  isError?: boolean
}

export interface McpClientOptions {
  /** Optional bearer. Omit to test the unauthenticated path. */
  token?: string | null
  /** clientInfo.name passed in `initialize` — flows into mcp_sessions.client_name. */
  clientName?: string
  /** Skip the auto-initialize so tests can assert pre-handshake behaviour. */
  skipInitialize?: boolean
  /** Reuse an existing `Mcp-Session-Id` (e.g. one another token created) instead of initializing. */
  sessionId?: string
  /** Server to talk to (default: the primary test server). */
  baseUrl?: string
}

export class McpClient {
  private nextRpcId = 1
  private sessionId: string | null = null
  private initialized = false
  readonly clientName: string
  private readonly baseUrl: string

  constructor(private readonly options: McpClientOptions = {}) {
    this.clientName = options.clientName ?? 'integration-test'
    this.baseUrl = options.baseUrl ?? TEST_BASE_URL
    if (options.sessionId) {
      this.sessionId = options.sessionId
      this.initialized = true
    }
  }

  /** Run the full handshake: initialize → notifications/initialized.
   *  Idempotent. Auto-called by the first `call` / `listTools` unless
   *  `skipInitialize` was set. */
  async initialize(): Promise<{ protocolVersion: string }> {
    if (this.initialized) return { protocolVersion: 'cached' }
    const init = await this.rawRpc<{ protocolVersion: string }>({
      jsonrpc: '2.0',
      id: this.nextRpcId++,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: this.clientName, version: '0.0.1' }
      }
    })
    if (init.error) {
      throw new Error(`[mcp-client] initialize failed: ${init.error.message}`)
    }

    // notifications/initialized has no response. Fire and forget — we
    // still need to send it so the toolkit transitions out of the
    // handshake state.
    await this.rawSend({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {}
    })

    this.initialized = true
    return init.result ?? { protocolVersion: 'unknown' }
  }

  /** tools/list. Returns the array unchanged from the server response. */
  async listTools(): Promise<ToolListEntry[]> {
    if (!this.initialized && !this.options.skipInitialize) await this.initialize()
    const res = await this.rawRpc<{ tools: ToolListEntry[] }>({
      jsonrpc: '2.0',
      id: this.nextRpcId++,
      method: 'tools/list',
      params: {}
    })
    if (res.error) throw new Error(`[mcp-client] tools/list error: ${res.error.message}`)
    return res.result?.tools ?? []
  }

  /** tools/call. Returns the full CallToolResult so tests can assert
   *  on `isError` / `structuredContent` / individual content blocks. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    if (!this.initialized && !this.options.skipInitialize) await this.initialize()
    const res = await this.rawRpc<CallToolResult>({
      jsonrpc: '2.0',
      id: this.nextRpcId++,
      method: 'tools/call',
      params: { name, arguments: args }
    })
    if (res.error) {
      // JSON-RPC error envelope (transport / framework). Bubble up so
      // tests can assert on the message + code.
      throw Object.assign(new Error(res.error.message), { rpcCode: res.error.code, rpcData: res.error.data })
    }
    if (!res.result) {
      throw new Error(`[mcp-client] tools/call ${name} returned no result`)
    }
    return res.result
  }

  /** Convenience: assert tool ran without `isError`, return first text block. */
  async callText(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const r = await this.call(name, args)
    if (r.isError) {
      const errText = r.content.find(c => c.type === 'text')?.text ?? '(no error text)'
      throw new Error(`[mcp-client] ${name} returned isError: ${errText}`)
    }
    const first = r.content[0]
    if (!first || first.type !== 'text') {
      throw new Error(`[mcp-client] ${name} first content block is not text: ${JSON.stringify(first)}`)
    }
    return first.text
  }

  /** Raw `initialize` exchange: HTTP status, assigned session id (if any) and the JSON-RPC body. */
  async rawInitialize(): Promise<{ status: number, sessionId: string | null, rpc: RpcResult<{ protocolVersion: string }> }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    }
    if (this.options.token) headers['Authorization'] = `Bearer ${this.options.token}`
    const res = await fetch(`${this.baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: this.nextRpcId++,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: this.clientName, version: '0.0.1' } }
      })
    })
    const sessionId = res.headers.get('mcp-session-id')
    const text = await res.text()
    return { status: res.status, sessionId, rpc: text ? this.parsePayload(text, res.status) : {} }
  }

  /** Returns the Mcp-Session-Id assigned by the server on initialize.
   *  Null until initialize has run + the server returned the header. */
  getSessionId(): string | null {
    return this.sessionId
  }

  // ─── Internals ────────────────────────────────────────────────────

  /** Send a JSON-RPC request and parse the response into RpcResult. */
  private async rawRpc<T>(body: object): Promise<RpcResult<T>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // Toolkit can return either; we accept both and parse whichever lands.
      'Accept': 'application/json, text/event-stream'
    }
    if (this.options.token) headers['Authorization'] = `Bearer ${this.options.token}`
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId

    const res = await fetch(`${this.baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    })

    // Capture session id off the response — assigned on initialize, then
    // echoed on subsequent calls so the toolkit can keep state.
    const newSession = res.headers.get('mcp-session-id')
    if (newSession) this.sessionId = newSession

    const text = await res.text()
    if (!text) {
      // Empty body — happens for notification responses (HTTP 202) and
      // for some toolkit error paths. Surface a minimal RpcResult.
      if (res.status >= 400) {
        return { error: { code: res.status, message: `HTTP ${res.status} (no body)` } }
      }
      return {}
    }

    return this.parsePayload<T>(text, res.status)
  }

  /** Send a JSON-RPC notification (no id, no response expected). */
  private async rawSend(body: object): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    }
    if (this.options.token) headers['Authorization'] = `Bearer ${this.options.token}`
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId
    await fetch(`${this.baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    })
  }

  /** Normalise SSE-or-JSON wire format into a single RpcResult shape. */
  private parsePayload<T>(text: string, status: number): RpcResult<T> {
    // SSE response — parse the first `data:` line as JSON.
    if (text.startsWith('event:') || text.includes('\ndata:') || text.startsWith('data:')) {
      const dataLine = text.split('\n').find(l => l.startsWith('data:'))
      if (!dataLine) {
        return { error: { code: status, message: `SSE response with no data line (status ${status})` } }
      }
      try {
        return JSON.parse(dataLine.slice(5).trim()) as RpcResult<T>
      } catch (e) {
        return { error: { code: status, message: `SSE parse error: ${(e as Error).message}` } }
      }
    }

    // Plain JSON — most toolkit responses.
    try {
      return JSON.parse(text) as RpcResult<T>
    } catch (e) {
      return { error: { code: status, message: `JSON parse error: ${(e as Error).message} | body: ${text.slice(0, 200)}` } }
    }
  }
}

/** Convenience factory: `mcp(token)` instead of `new McpClient({token})`. */
export function mcp(token: string | null = null, opts: Omit<McpClientOptions, 'token'> = {}): McpClient {
  return new McpClient({ ...opts, token })
}
