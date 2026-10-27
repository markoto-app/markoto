import { describe, it, expect, vi } from 'vitest'
import { evaluateMcpRequest, jsonRpcErrorResponse, MCP_RATE_LIMITS, type McpGateDeps, type RateLimitRule } from '../../server/mcp/lib/mcpGate'
import { McpSessionBindings, MAX_SESSIONS_PER_USER, BINDING_IDLE_MS } from '../../server/utils/mcpSessionBinding'
import type { McpAuthContext } from '../../server/utils/mcpAuth'

// /mcp request gate (A3 / A4 / A5): no session without a verified token,
// sessions bound to the token that created them, rate limits per client
// address and per token, bounded sessions per user.

const ALICE_FULL: McpAuthContext = { userId: 1, scopes: ['documents:read', 'documents:write'], tokenId: 'mkt_pat_full' }
const ALICE_RO: McpAuthContext = { userId: 1, scopes: ['documents:read'], tokenId: 'mkt_pat_ro' }

function deps(overrides: Partial<McpGateDeps> = {}): McpGateDeps & { rateLimit: ReturnType<typeof vi.fn> } {
  const tokens: Record<string, McpAuthContext> = { 'Bearer full': ALICE_FULL, 'Bearer ro': ALICE_RO }
  const rateLimit = vi.fn(async (_rule: RateLimitRule, _key: string) => true)
  return {
    verifyToken: async h => (h ? tokens[h] ?? null : null),
    rateLimit,
    bindings: new McpSessionBindings(),
    ...overrides
  }
}

describe('evaluateMcpRequest', () => {
  it('refuses a request without a valid token (403 JSON-RPC, never 401) — before any session exists', async () => {
    const d = deps()
    for (const authHeader of [undefined, 'Bearer nope']) {
      const r = await evaluateMcpRequest({ authHeader, clientKey: '203.0.113.9', sessionId: null }, d)
      expect(r).toMatchObject({ kind: 'reject', status: 403 })
    }
    expect(d.bindings.countForUser(1)).toBe(0)
  })

  it('lets a verified token open a session', async () => {
    const r = await evaluateMcpRequest({ authHeader: 'Bearer full', clientKey: 'c', sessionId: null }, deps())
    expect(r).toEqual({ kind: 'proceed', auth: ALICE_FULL, opensSession: true })
  })

  it('serves a session only to the token that created it', async () => {
    const d = deps()
    d.bindings.bind('sess-1', ALICE_FULL.tokenId, ALICE_FULL.userId)
    expect(await evaluateMcpRequest({ authHeader: 'Bearer full', clientKey: 'c', sessionId: 'sess-1' }, d))
      .toEqual({ kind: 'proceed', auth: ALICE_FULL, opensSession: false })
    // Same user, other (read-only) token → as if the session did not exist.
    expect(await evaluateMcpRequest({ authHeader: 'Bearer ro', clientKey: 'c', sessionId: 'sess-1' }, d))
      .toMatchObject({ kind: 'reject', status: 404, message: 'Session not found' })
    // Unknown session id.
    expect(await evaluateMcpRequest({ authHeader: 'Bearer full', clientKey: 'c', sessionId: 'sess-x' }, d))
      .toMatchObject({ kind: 'reject', status: 404 })
  })

  it('rate-limits per client address first, then per token', async () => {
    const perClient = deps({ rateLimit: vi.fn(async (rule: RateLimitRule) => rule.namespace !== MCP_RATE_LIMITS.perClient.namespace) })
    expect(await evaluateMcpRequest({ authHeader: 'Bearer full', clientKey: 'c', sessionId: null }, perClient))
      .toMatchObject({ kind: 'reject', status: 429 })

    const d = deps({ rateLimit: vi.fn(async (rule: RateLimitRule) => rule.namespace !== MCP_RATE_LIMITS.perToken.namespace) })
    expect(await evaluateMcpRequest({ authHeader: 'Bearer full', clientKey: 'c', sessionId: null }, d))
      .toMatchObject({ kind: 'reject', status: 429 })
    expect(d.rateLimit).toHaveBeenCalledWith(MCP_RATE_LIMITS.perToken, ALICE_FULL.tokenId)
  })

  it('rate-limits new sessions per user (not requests on an existing session)', async () => {
    const d = deps({ rateLimit: vi.fn(async (rule: RateLimitRule) => rule.namespace !== MCP_RATE_LIMITS.sessionsPerUser.namespace) })
    expect(await evaluateMcpRequest({ authHeader: 'Bearer full', clientKey: 'c', sessionId: null }, d))
      .toMatchObject({ kind: 'reject', status: 429 })
    expect(d.rateLimit).toHaveBeenCalledWith(MCP_RATE_LIMITS.sessionsPerUser, '1')
    d.bindings.bind('sess-1', ALICE_FULL.tokenId, 1)
    expect(await evaluateMcpRequest({ authHeader: 'Bearer full', clientKey: 'c', sessionId: 'sess-1' }, d))
      .toMatchObject({ kind: 'proceed', opensSession: false })
  })
})

describe('McpSessionBindings', () => {
  it('keeps at most MAX_SESSIONS_PER_USER per user, dropping the least recently used', () => {
    let now = 0
    const b = new McpSessionBindings(() => now)
    for (let i = 0; i < MAX_SESSIONS_PER_USER; i++) {
      now += 1
      b.bind(`s${i}`, 't1', 1)
    }
    now += 1
    expect(b.check('s0', 't1')).toBe('ok') // s0 is now the most recently used
    now += 1
    b.bind('new', 't1', 1)
    expect(b.countForUser(1)).toBe(MAX_SESSIONS_PER_USER)
    expect(b.check('s1', 't1')).toBe('unknown') // the least recently used one went
    expect(b.check('s0', 't1')).toBe('ok')
    expect(b.check('new', 't1')).toBe('ok')
    // Other users are unaffected.
    b.bind('bob', 't2', 2)
    expect(b.check('bob', 't2')).toBe('ok')
  })

  it('forgets idle sessions (and frees the per-user slot)', () => {
    let now = 0
    const b = new McpSessionBindings(() => now)
    b.bind('s1', 't1', 1)
    expect(b.check('s1', 't1')).toBe('ok')
    expect(b.countForUser(1)).toBe(1)
    now += BINDING_IDLE_MS + 1
    expect(b.check('s1', 't1')).toBe('unknown')
    expect(b.countForUser(1)).toBe(0)
  })

  it('a successful check keeps the session alive', () => {
    let now = 0
    const b = new McpSessionBindings(() => now)
    b.bind('s1', 't1', 1)
    now += BINDING_IDLE_MS - 1
    expect(b.check('s1', 't1')).toBe('ok')
    now += BINDING_IDLE_MS - 1
    expect(b.check('s1', 't1')).toBe('ok')
    expect(b.check('s1', 't2')).toBe('token-mismatch')
  })
})

describe('jsonRpcErrorResponse', () => {
  it('builds a JSON-RPC error with Retry-After on 429', async () => {
    const res = jsonRpcErrorResponse(429, -32000, 'slow down')
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('60')
    expect(await res.json()).toEqual({ jsonrpc: '2.0', error: { code: -32000, message: 'slow down' }, id: null })
  })
})
