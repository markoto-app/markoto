import { describe, it, expect, beforeEach } from 'vitest'
import { deleteValkeyKey, getValkeyKey, resetDb, setValkeyKey, testDb } from '../setup/db'
import { createDoc, createUser } from '../setup/fixtures'
import { loggedInClient } from '../setup/client'
import { mcp, mintPat, McpClient } from '../setup/mcpClient'

// A4: an MCP session belongs to the personal access token that created
// it. The toolkit fixes a session's tool list from the creating token's
// scopes, so before this binding a read-only token presented with the
// session id of a full-scope token reached the write tools. Now any
// other token gets "Session not found", exactly like an unknown id.

describe('MCP sessions are bound to their token', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('a read-only token cannot ride a session created by a full-scope token of the same user', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })
    const full = await mintPat({ userId: user.id, scopes: ['documents:read', 'documents:write'] })
    const ro = await mintPat({ userId: user.id, scopes: ['documents:read'] })

    const owner = mcp(full.plaintext)
    await owner.initialize()
    const sessionId = owner.getSessionId()
    expect(sessionId).toBeTruthy()

    const hijack = new McpClient({ token: ro.plaintext, sessionId: sessionId ?? undefined })
    await expect(hijack.call('set_title', { doc_id: doc.docId, title: 'pwned' })).rejects.toThrow(/Session not found/)
    await expect(hijack.listTools()).rejects.toThrow(/Session not found/)

    const title = await testDb().query<{ title: string }>('SELECT title FROM documents WHERE doc_id = $1', [doc.docId])
    expect(title.rows[0]?.title).not.toBe('pwned')
  })

  it('another user\'s token cannot use the session either', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const a = await mintPat({ userId: alice.id, scopes: ['documents:read'] })
    const b = await mintPat({ userId: bob.id, scopes: ['documents:read'] })
    const owner = mcp(a.plaintext)
    await owner.initialize()
    const intruder = new McpClient({ token: b.plaintext, sessionId: owner.getSessionId() ?? undefined })
    await expect(intruder.listTools()).rejects.toThrow(/Session not found/)
  })

  it('the creating token keeps working, and the session row records it', async () => {
    const user = await createUser()
    const t = await mintPat({ userId: user.id, scopes: ['documents:read'] })
    const client = mcp(t.plaintext, { clientName: 'Bound Client' })
    expect((await client.listTools()).length).toBeGreaterThan(0)
    expect((await client.listTools()).length).toBeGreaterThan(0)

    // The row is written fire-and-forget on initialize; give it a moment.
    const sid = client.getSessionId()
    let row: { token_id: string, client_name: string | null } | undefined
    for (let i = 0; i < 50 && !row; i++) {
      const r = await testDb().query<{ token_id: string, client_name: string | null }>(
        'SELECT token_id, client_name FROM mcp_sessions WHERE mcp_session_id = $1',
        [sid]
      )
      row = r.rows[0]
      if (!row) await new Promise(res => setTimeout(res, 100))
    }
    expect(row).toEqual({ token_id: t.tokenId, client_name: 'Bound Client' })
  })
})

// F-7d: the bindings live in Valkey (not in the app process), so they
// survive a restart and are shared by every instance.
describe('MCP session bindings are stored in Valkey', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('initialize writes the binding to Valkey; the gate reads it from there on every request', async () => {
    const user = await createUser()
    const t = await mintPat({ userId: user.id, scopes: ['documents:read'] })
    const client = mcp(t.plaintext)
    await client.initialize()
    const sid = client.getSessionId() ?? ''
    expect(await getValkeyKey(`mcp:binding:${sid}`)).toBe(`${user.id}:${t.tokenId}`)
    expect((await client.listTools()).length).toBeGreaterThan(0)

    // Simulated restart / other instance: the app keeps nothing of its
    // own — dropping the Valkey entry is enough to refuse the session
    // even though this process still holds the toolkit session.
    await deleteValkeyKey(`mcp:binding:${sid}`)
    await expect(client.listTools()).rejects.toThrow(/Session not found/)
  })

  it('a binding written by "another instance" is honoured here (shared table)', async () => {
    const user = await createUser()
    const a = await mintPat({ userId: user.id, scopes: ['documents:read'] })
    const b = await mintPat({ userId: user.id, scopes: ['documents:read'] })
    const owner = mcp(a.plaintext)
    await owner.initialize()
    const sid = owner.getSessionId() ?? ''
    // Re-point the stored binding as another instance would see it.
    await setValkeyKey(`mcp:binding:${sid}`, `${user.id}:${b.tokenId}`)
    await expect(owner.listTools()).rejects.toThrow(/Session not found/)
    const other = new McpClient({ token: b.plaintext, sessionId: sid })
    expect((await other.listTools()).length).toBeGreaterThan(0)
  })

  it('revoking the token drops its bindings', async () => {
    const user = await createUser()
    const t = await mintPat({ userId: user.id, scopes: ['documents:read'] })
    const client = mcp(t.plaintext)
    await client.initialize()
    const sid = client.getSessionId() ?? ''
    expect(await getValkeyKey(`mcp:binding:${sid}`)).not.toBe(null)
    const web = await loggedInClient(user.id)
    expect((await web.delete(`/api/mcp/tokens/${t.tokenId}`)).status).toBe(200)
    expect(await getValkeyKey(`mcp:binding:${sid}`)).toBe(null)
    await expect(client.listTools()).rejects.toThrow()
  })

  it('keeps at most 20 usable sessions per user — the least recently used one is dropped', async () => {
    const user = await createUser()
    const t = await mintPat({ userId: user.id, scopes: ['documents:read'] })
    const first = mcp(t.plaintext)
    await first.initialize()
    for (let i = 0; i < 20; i++) await mcp(t.plaintext).initialize()
    await expect(first.listTools()).rejects.toThrow(/Session not found/)
  }, 60_000)
})
