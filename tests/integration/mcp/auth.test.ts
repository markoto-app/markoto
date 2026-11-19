import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { createUser } from '../setup/fixtures'
import { mcp, mintPat } from '../setup/mcpClient'

// Auth surface for the /mcp endpoint. The MCP route NEVER answers 401
// (clients interpret that as an OAuth-discovery hint and switch
// protocols). A request without a valid token is refused with HTTP 403 +
// a JSON-RPC error BEFORE the toolkit runs, so no server session is
// ever created for it (anonymous `initialize` calls used to fill the
// toolkit's global session table). Under-scoped callers see only the
// tools their scopes allow.
//
// These tests pin both halves of that contract:
//   - bad/missing/revoked/expired token → 403 refusal, no session id
//   - per-scope subset → exactly the right tools surface
//
// Calling a hidden tool comes back as "Tool not found" (toolkit's
// chosen shape: same as if the tool didn't exist).

describe('MCP auth: token validity', () => {
  beforeEach(async () => {
    await resetDb()
  })

  async function expectRefused(token: string | null): Promise<void> {
    const r = await mcp(token).rawInitialize()
    expect(r.status).toBe(403)
    expect(r.sessionId).toBeNull()
    expect(r.rpc.error?.message).toMatch(/Authentication required/)
  }

  it('no Authorization header → refused, no session', async () => {
    await expectRefused(null)
  })

  it('malformed bearer (wrong prefix) → refused', async () => {
    await expectRefused('not-a-real-token')
  })

  it('correctly-shaped but non-existent token → refused', async () => {
    // mkt_ prefix + 32 base32 chars: passes shape, fails DB lookup.
    await expectRefused('mkt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
  })

  it('revoked token → refused', async () => {
    const user = await createUser()
    const { plaintext, tokenId } = await mintPat({ userId: user.id, scopes: ['documents:read'] })

    // Revoke without ever having "used" the token (no Valkey cache hit).
    const db = testDb()
    await db.query(
      `UPDATE mcp_personal_tokens SET revoked_at = NOW() WHERE token_id = $1`,
      [tokenId]
    )
    await expectRefused(plaintext)
  })

  it('expired token → refused', async () => {
    const user = await createUser()
    const { plaintext } = await mintPat({
      userId: user.id,
      scopes: ['documents:read'],
      expiresAt: new Date(Date.now() - 60_000) // 1 minute in the past
    })
    await expectRefused(plaintext)
  })

  it('many anonymous initialize calls create no sessions, a real user still connects', async () => {
    // The toolkit keeps at most 1000 sessions per process; anonymous
    // initialize calls must not consume them.
    for (let i = 0; i < 25; i++) await expectRefused(null)
    const user = await createUser()
    const { plaintext } = await mintPat({ userId: user.id, scopes: ['documents:read'] })
    const r = await mcp(plaintext).rawInitialize()
    expect(r.status).toBe(200)
    expect(r.sessionId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('verify cache makes revocation eventual within TTL (cached hit survives DB revoke)', async () => {
    // Belt-and-braces test for the documented Valkey 60s cache window.
    // First call seeds the cache; DB revoke then doesn't immediately
    // bite: the cached entry covers the next ~60s. Tests should expect
    // this rather than be surprised by it.
    const user = await createUser()
    const { plaintext, tokenId } = await mintPat({ userId: user.id, scopes: ['documents:read'] })
    const client = mcp(plaintext)

    const before = await client.listTools()
    expect(before.length).toBeGreaterThan(0)

    // Revoke at the DB. Cache still holds the positive verification.
    const db = testDb()
    const result = await db.query<{ revoked_at: Date }>(
      `UPDATE mcp_personal_tokens SET revoked_at = NOW() WHERE token_id = $1 RETURNING revoked_at`,
      [tokenId]
    )
    expect(result.rows[0]!.revoked_at).toBeInstanceOf(Date)

    // Same token, fresh client (no per-client cache), toolkit's
    // verifier still sees the cached Valkey hit, so listing succeeds.
    // This is the documented behaviour, NOT a bug. Operators rotate
    // tokens with the 60s TTL in mind.
    const after = await mcp(plaintext).listTools()
    expect(after.length).toBeGreaterThan(0)
  })
})

describe('MCP auth: scope gating', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('documents:read alone → exactly the 17 read tools', async () => {
    const user = await createUser()
    const { plaintext } = await mintPat({ userId: user.id, scopes: ['documents:read'] })

    const tools = await mcp(plaintext).listTools()
    const names = tools.map(t => t.name).sort()

    const expected = [
      'export_document_as_markdown', 'export_document_as_pdf',
      'get_page_count', 'get_theme', 'list_folders', 'list_my_documents', 'list_themes',
      'list_workspace_documents', 'outline', 'read_comments', 'read_section',
      'search_activity_log', 'search_document', 'search_documents', 'view_document', 'view_image',
      'view_pages'
    ].sort()

    expect(names).toEqual(expected)
  })

  it('documents:read + documents:write → 40 tools (17 read + 23 write, incl. generate_image)', async () => {
    const user = await createUser()
    const { plaintext } = await mintPat({
      userId: user.id,
      scopes: ['documents:read', 'documents:write']
    })

    const tools = await mcp(plaintext).listTools()
    expect(tools.length).toBe(40)

    const names = tools.map(t => t.name)
    // Spot-check: write tools surface, knowledge + web do not.
    expect(names).toContain('replace_text')
    expect(names).toContain('create_document')
    // generate_image writes an asset into a doc → documents:write.
    expect(names).toContain('generate_image')
    expect(names).not.toContain('search_knowledge')
    expect(names).not.toContain('web_search')
  })

  it('all 4 scopes → 44 tools', async () => {
    const user = await createUser()
    const { plaintext } = await mintPat({
      userId: user.id,
      scopes: ['documents:read', 'documents:write', 'knowledge:read', 'web:fetch']
    })

    const tools = await mcp(plaintext).listTools()
    expect(tools.length).toBe(44)

    const names = tools.map(t => t.name).sort()
    expect(names).toContain('search_knowledge')
    expect(names).toContain('web_search')
    expect(names).toContain('generate_image')
    expect(names).toContain('fetch_url')
  })

  it('knowledge:read alone → 2 knowledge tools, no docs/web tools', async () => {
    const user = await createUser()
    const { plaintext } = await mintPat({ userId: user.id, scopes: ['knowledge:read'] })

    const tools = await mcp(plaintext).listTools()
    const names = tools.map(t => t.name).sort()
    expect(names).toEqual(['get_knowledge_file', 'search_knowledge'])
  })

  it('web:fetch alone → the 2 web-read tools, no docs/knowledge tools (generate_image needs documents:write)', async () => {
    const user = await createUser()
    const { plaintext } = await mintPat({ userId: user.id, scopes: ['web:fetch'] })

    const tools = await mcp(plaintext).listTools()
    const names = tools.map(t => t.name).sort()
    expect(names).toEqual(['fetch_url', 'web_search'])
  })

  it('calling a tool outside granted scope is rejected (read-only PAT cannot call replace_text)', async () => {
    const user = await createUser()
    const { plaintext } = await mintPat({ userId: user.id, scopes: ['documents:read'] })

    // The toolkit's chosen shape for "tool exists but not visible to
    // this caller" is the SAME as for "tool doesn't exist": a
    // CallToolResult with isError:true + text "Tool X not found".
    // That's the right anti-enumeration shape, a separate
    // "forbidden" response would leak the tool's existence.
    const res = await mcp(plaintext).call('replace_text', {
      doc_id: 'whatever', old_str: 'a', new_str: 'b'
    })
    expect(res.isError).toBe(true)
    expect(res.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('not found')
    })
  })
})
