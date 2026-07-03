import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  MCP_TOKEN_PREFIX,
  MCP_SCOPES,
  generateMcpToken,
  hashToken,
  extractMcpBearer,
  hasScope,
  type McpScope
} from '../../server/utils/mcpAuth'

// Pure-function tests for the PAT primitives. The verifier (verifyMcpPat)
// + cache invalidation are repo-level and need a live DB + Valkey, so
// they're covered by integration tests; this file pins the wire shape
// (token format, header parsing, hash stability, scope membership).

describe('generateMcpToken', () => {
  it('returns a token with the mkt_ prefix + 32-char base32 body', () => {
    const { plaintext } = generateMcpToken()
    expect(plaintext).toMatch(/^mkt_[A-Z2-7]{32}$/)
    expect(plaintext.length).toBe(MCP_TOKEN_PREFIX.length + 32)
  })

  it('returns a hash matching SHA-256(plaintext) hex', () => {
    const { plaintext, hash } = generateMcpToken()
    const expected = createHash('sha256').update(plaintext).digest('hex')
    expect(hash).toBe(expected)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('produces unique tokens across calls (entropy sanity)', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 100; i++) seen.add(generateMcpToken().plaintext)
    expect(seen.size).toBe(100)
  })
})

describe('hashToken', () => {
  it('is deterministic for the same input', () => {
    expect(hashToken('mkt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe(
      hashToken('mkt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    )
  })

  it('produces a different hash for any input flip', () => {
    const a = hashToken('mkt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    const b = hashToken('mkt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB')
    expect(a).not.toBe(b)
  })
})

describe('extractMcpBearer', () => {
  it('extracts a valid Bearer mkt_… header', () => {
    const token = `${MCP_TOKEN_PREFIX}${'A'.repeat(32)}`
    expect(extractMcpBearer(`Bearer ${token}`)).toBe(token)
  })

  it('is case-insensitive on the scheme', () => {
    const token = `${MCP_TOKEN_PREFIX}${'A'.repeat(32)}`
    expect(extractMcpBearer(`bearer ${token}`)).toBe(token)
    expect(extractMcpBearer(`BEARER ${token}`)).toBe(token)
  })

  it('returns null for missing header', () => {
    expect(extractMcpBearer(undefined)).toBeNull()
    expect(extractMcpBearer(null)).toBeNull()
    expect(extractMcpBearer('')).toBeNull()
  })

  it('returns null for non-Bearer schemes', () => {
    const token = `${MCP_TOKEN_PREFIX}${'A'.repeat(32)}`
    expect(extractMcpBearer(`Basic ${token}`)).toBeNull()
    expect(extractMcpBearer(token)).toBeNull()
  })

  it('returns null for tokens without the mkt_ prefix', () => {
    expect(extractMcpBearer(`Bearer ghp_${'A'.repeat(32)}`)).toBeNull()
    expect(extractMcpBearer(`Bearer ${'A'.repeat(36)}`)).toBeNull()
  })

  it('returns null for tokens of the wrong length', () => {
    expect(extractMcpBearer(`Bearer ${MCP_TOKEN_PREFIX}${'A'.repeat(31)}`)).toBeNull()
    expect(extractMcpBearer(`Bearer ${MCP_TOKEN_PREFIX}${'A'.repeat(33)}`)).toBeNull()
  })
})

describe('hasScope', () => {
  it('returns true when the scope is granted', () => {
    const scopes: McpScope[] = ['documents:read', 'documents:write']
    expect(hasScope(scopes, 'documents:read')).toBe(true)
    expect(hasScope(scopes, 'documents:write')).toBe(true)
  })

  it('returns false when the scope is missing', () => {
    const scopes: McpScope[] = ['documents:read']
    expect(hasScope(scopes, 'documents:write')).toBe(false)
    expect(hasScope(scopes, 'web:fetch')).toBe(false)
  })

  it('returns false on undefined / non-array input', () => {
    expect(hasScope(undefined, 'documents:read')).toBe(false)
    // Cast lets us test runtime defense without TS rejecting the call shape.
    expect(hasScope(null as unknown as McpScope[], 'documents:read')).toBe(false)
  })
})

describe('MCP_SCOPES', () => {
  it('exposes the v1 scope set', () => {
    expect(MCP_SCOPES).toEqual([
      'documents:read',
      'documents:write',
      'knowledge:read',
      'web:fetch'
    ])
  })
})
