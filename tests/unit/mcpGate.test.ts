import { describe, it, expect, vi } from 'vitest'
import { evaluateMcpRequest, jsonRpcErrorResponse, MCP_RATE_LIMITS, type McpGateDeps, type RateLimitRule } from '../../server/mcp/lib/mcpGate'
import type { BindingCheck, McpSessionBindings } from '../../server/utils/mcp/mcpSessionBinding'
import type { McpAuthContext } from '../../server/utils/mcp/mcpAuth'

// /mcp request gate (A3 / A4 / A5): no session without a verified token,
// sessions bound to the token that created them, rate limits per client
// address and per token, bounded sessions per user.

const ALICE_FULL: McpAuthContext = { userId: 1, scopes: ['documents:read', 'documents:write'], tokenId: 'mkt_pat_full' }
const ALICE_RO: McpAuthContext = { userId: 1, scopes: ['documents:read'], tokenId: 'mkt_pat_ro' }

/**
 * Plain in-memory binding table for the gate's decision logic. The real
 * table (Valkey: set-if-absent, per-user LRU cap, idle expiry, revoke)
 * is tested against the Valkey container in tests/repos/mcpSessionBinding.test.ts.
 */
function memoryBindings(): McpSessionBindings & { throwOnCheck: boolean } {
  const table = new Map<string, { tokenId: string, userId: number }>()
  return {
    throwOnCheck: false,
    async bind(sessionId, tokenId, userId) {
      if (table.has(sessionId)) return false
      table.set(sessionId, { tokenId, userId })
      return true
    },
    async check(sessionId, tokenId): Promise<BindingCheck> {
      if (this.throwOnCheck) throw new Error('valkey down')
      const b = table.get(sessionId)
      if (!b) return 'unknown'
      return b.tokenId === tokenId ? 'ok' : 'token-mismatch'
    },
    async countForUser(userId) {
      return [...table.values()].filter(b => b.userId === userId).length
    },
    async release(sessionId) {
      table.delete(sessionId)
    },
    async releaseToken(tokenId) {
      let n = 0
      for (const [id, b] of table) {
        if (b.tokenId === tokenId) {
          table.delete(id)
          n++
        }
      }
      return n
    }
  }
}

function deps(overrides: Partial<Omit<McpGateDeps, 'bindings'>> = {}): McpGateDeps & { rateLimit: ReturnType<typeof vi.fn>, bindings: ReturnType<typeof memoryBindings> } {
  const tokens: Record<string, McpAuthContext> = { 'Bearer full': ALICE_FULL, 'Bearer ro': ALICE_RO }
  const rateLimit = vi.fn(async (_rule: RateLimitRule, _key: string) => true)
  return {
    verifyToken: async h => (h ? tokens[h] ?? null : null),
    rateLimit,
    bindings: memoryBindings(),
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
    expect(await d.bindings.countForUser(1)).toBe(0)
  })

  it('lets a verified token open a session', async () => {
    const r = await evaluateMcpRequest({ authHeader: 'Bearer full', clientKey: 'c', sessionId: null }, deps())
    expect(r).toEqual({ kind: 'proceed', auth: ALICE_FULL, opensSession: true })
  })

  it('serves a session only to the token that created it', async () => {
    const d = deps()
    await d.bindings.bind('sess-1', ALICE_FULL.tokenId, ALICE_FULL.userId)
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
    await d.bindings.bind('sess-1', ALICE_FULL.tokenId, 1)
    expect(await evaluateMcpRequest({ authHeader: 'Bearer full', clientKey: 'c', sessionId: 'sess-1' }, d))
      .toMatchObject({ kind: 'proceed', opensSession: false })
  })
})

describe('evaluateMcpRequest — binding storage failure', () => {
  it('refuses the session when the binding lookup fails (fail closed)', async () => {
    const d = deps()
    await d.bindings.bind('sess-1', ALICE_FULL.tokenId, 1)
    d.bindings.throwOnCheck = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await evaluateMcpRequest({ authHeader: 'Bearer full', clientKey: 'c', sessionId: 'sess-1' }, d))
      .toMatchObject({ kind: 'reject', status: 404, message: 'Session not found' })
    warn.mockRestore()
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
