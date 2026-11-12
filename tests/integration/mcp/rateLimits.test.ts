import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from '../setup/db'
import { createDoc, createUser } from '../setup/fixtures'
import { TEST_BILLING_OFF_BASE_URL } from '../setup/env'
import { McpClient, mintPat, type CallToolResult } from '../setup/mcpClient'
import { MCP_RATE_LIMITS } from '../../../server/mcp/lib/mcpGate'

// The MCP limits over real HTTP. Test mode bypasses rate limits, so these
// run against the billing-off server, which ENFORCES the MCP namespaces
// (`TEST_ENFORCE_RATE_LIMITS`, see setup/server.ts). Every limit is
// driven to exactly its maximum and one past it. `resetDb()` also
// flushes Valkey, so each test starts with empty windows.

const BASE = TEST_BILLING_OFF_BASE_URL

function client(token: string | null, opts: { sessionId?: string } = {}): McpClient {
  return new McpClient({ token, baseUrl: BASE, ...opts })
}

function errorText(res: CallToolResult): string {
  const first = res.content[0]
  return first?.type === 'text' ? first.text : ''
}

/** Run `fn` `n` times, `batch` at a time (keeps the sequence of windows deterministic enough without 300 serial round trips). */
async function repeat(n: number, fn: () => Promise<void>, batch = 25): Promise<void> {
  for (let done = 0; done < n; done += batch) {
    await Promise.all(Array.from({ length: Math.min(batch, n - done) }, () => fn()))
  }
}

beforeEach(async () => {
  await resetDb()
})

describe('MCP rate limits (enforced)', () => {
  it('per client address: the request after the limit gets 429, even without a token', async () => {
    const { max } = MCP_RATE_LIMITS.perClient
    const statuses: number[] = []
    await repeat(max, async () => {
      statuses.push((await client(null).rawInitialize()).status)
    })
    // Every request inside the limit reaches the auth check (403, no token).
    expect(statuses.filter(s => s === 403)).toHaveLength(max)

    const over = await client(null).rawInitialize()
    expect(over.status).toBe(429)
    expect(over.rpc.error?.message).toMatch(/Too many requests/)
  })

  it('per token: requests past the limit are refused for that token only', async () => {
    const user = await createUser()
    const a = await mintPat({ userId: user.id, scopes: ['documents:read'] })
    const b = await mintPat({ userId: user.id, scopes: ['documents:read'] })
    const { max } = MCP_RATE_LIMITS.perToken

    const c = client(a.plaintext)
    await c.initialize() // 2 requests: initialize + notifications/initialized
    await repeat(max - 2, async () => {
      await c.listTools()
    }, 20)
    await expect(c.listTools()).rejects.toThrow(/Too many requests for this token/)

    // Another token of the same user has its own window.
    expect((await client(b.plaintext).listTools()).length).toBeGreaterThan(0)
  })

  it('new sessions per user: the session after the limit is refused', async () => {
    const user = await createUser()
    const pat = await mintPat({ userId: user.id, scopes: ['documents:read'] })
    const { max } = MCP_RATE_LIMITS.sessionsPerUser

    const sessions = new Set<string>()
    await repeat(max, async () => {
      const r = await client(pat.plaintext).rawInitialize()
      expect(r.status).toBe(200)
      if (r.sessionId) sessions.add(r.sessionId)
    }, 10)
    expect(sessions.size).toBe(max)

    const over = await client(pat.plaintext).rawInitialize()
    expect(over.status).toBe(429)
    expect(over.sessionId).toBeNull()
    expect(over.rpc.error?.message).toMatch(/Too many new MCP sessions/)
  })

  it('tool calls per user: counted across all of the user\'s tokens', async () => {
    const user = await createUser()
    const a = client((await mintPat({ userId: user.id, scopes: ['documents:read'] })).plaintext)
    const b = client((await mintPat({ userId: user.id, scopes: ['documents:read'] })).plaintext)
    const { max } = MCP_RATE_LIMITS.toolCallsPerUser
    await a.initialize()
    await b.initialize()

    let ok = 0
    await repeat(max / 2, async () => {
      const [ra, rb] = await Promise.all([a.call('list_my_documents', {}), b.call('list_my_documents', {})])
      if (!ra.isError) ok++
      if (!rb.isError) ok++
    }, 10)
    expect(ok).toBe(max)

    const over = await a.call('list_my_documents', {})
    expect(over.isError).toBe(true)
    // The agent learns the limit and its window, so it knows how long to back off.
    expect(errorText(over)).toContain(`limit: ${max} per 1 min`)
  })

  it('generate_image has its own per-user allowance, checked before any work', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })
    const c = client((await mintPat({ userId: user.id, scopes: ['documents:read', 'documents:write'] })).plaintext)
    const { max } = MCP_RATE_LIMITS.generateImagePerUser

    // A doc id the user can't reach: admitted (allowance spent), then
    // refused by the doc check — no image is generated.
    for (let i = 0; i < max; i++) {
      const r = await c.call('generate_image', { doc_id: 'no-such-doc', prompt: 'a lighthouse', alt: 'lighthouse' })
      expect(r.isError).toBe(true)
      expect(errorText(r)).toMatch(/not found/)
    }
    const over = await c.call('generate_image', { doc_id: doc.docId, prompt: 'a lighthouse', alt: 'lighthouse' })
    expect(over.isError).toBe(true)
    expect(errorText(over)).toContain(`limit: ${max} per 60 min`)
  })
})
