import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from '../setup/db'
import { createUser } from '../setup/fixtures'
import { mcp, mintPat } from '../setup/mcpClient'

// Smallest possible smoke that asserts the harness is wired correctly.
// If this file fails, none of the other MCP integration tests will work
// keep it tiny and fast so a green run here is a strong signal.

describe('MCP harness', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('initializes, lists tools, and assigns Mcp-Session-Id', async () => {
    const user = await createUser()
    const { plaintext } = await mintPat({ userId: user.id, scopes: ['documents:read'] })

    const client = mcp(plaintext)
    const init = await client.initialize()
    expect(init.protocolVersion).toBeTruthy()
    expect(client.getSessionId()).toMatch(/^[0-9a-f-]{36}$/)

    const tools = await client.listTools()
    // documents:read alone gates 12 tools; if this drops, something
    // structural shifted in scope routing, bigger test files will
    // catch the specific tool, this one just asserts >= a floor.
    expect(tools.length).toBeGreaterThanOrEqual(10)
    expect(tools.map(t => t.name)).toContain('view_document')
  })
})
