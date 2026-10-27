import { describe, it, expect, beforeEach } from 'vitest'
import { deleteValkeyKey, resetDb, testDb } from '../setup/db'
import { createDoc, createUser } from '../setup/fixtures'
import { mcp, mintPat } from '../setup/mcpClient'
import { hashToken } from '../../../server/utils/mcpAuth'

// A session's tool list is fixed at `initialize` from the token's scopes
// at that moment. `admitToolCall` re-checks the scope on EVERY call, so a
// token whose scopes shrink mid-session loses the tools it no longer
// covers immediately, even though the session still lists them.

/** Narrow a token's scopes the way the server would see it: the DB row
 *  changes and the 60 s verification cache entry is dropped (as
 *  revocation does via `invalidateMcpPatCache`). */
async function setScopes(plaintext: string, tokenId: string, scopes: string[]): Promise<void> {
  await testDb().query('UPDATE mcp_personal_tokens SET scopes = $1 WHERE token_id = $2', [scopes, tokenId])
  await deleteValkeyKey(`mcp:pat:verify:${hashToken(plaintext)}`)
}

describe('MCP per-call scope re-check', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('a token reduced to read-only mid-session can no longer call write tools', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id, title: 'Before' })
    const pat = await mintPat({ userId: user.id, scopes: ['documents:read', 'documents:write'] })
    const client = mcp(pat.plaintext)

    const tools = (await client.listTools()).map(t => t.name)
    expect(tools).toContain('set_title')

    await setScopes(pat.plaintext, pat.tokenId, ['documents:read'])

    const res = await client.call('set_title', { doc_id: doc.docId, title: 'After' })
    expect(res.isError).toBe(true)
    expect(res.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Tool set_title not found') })

    const title = await testDb().query<{ title: string }>('SELECT title FROM documents WHERE doc_id = $1', [doc.docId])
    expect(title.rows[0]?.title).toBe('Before')

    // Tools the remaining scope covers keep working in the same session.
    const list = await client.call('list_my_documents', {})
    expect(list.isError).not.toBe(true)
  })

  it('a token that lost every scope is refused on its next call', async () => {
    const user = await createUser()
    const pat = await mintPat({ userId: user.id, scopes: ['documents:read'] })
    const client = mcp(pat.plaintext)
    expect((await client.call('list_my_documents', {})).isError).not.toBe(true)

    await setScopes(pat.plaintext, pat.tokenId, [])

    const res = await client.call('list_my_documents', {})
    expect(res.isError).toBe(true)
    expect(res.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Tool list_my_documents not found') })
  })
})
