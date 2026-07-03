import { describe, it, expect, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { resetDb, testDb } from '../setup/db'
import { createDoc, createUser } from '../setup/fixtures'
import { mcp, mintPat } from '../setup/mcpClient'

// The Phase 3 audit chain end-to-end:
//
//   activity_log.actor_principal LIKE 'mcp:%'
//     → strip 'mcp:' prefix
//     → mcp_sessions.mcp_session_id
//     → mcp_sessions.user_id        → users.id (the human)
//     → mcp_sessions.client_name    (e.g. 'Claude Desktop')
//     → mcp_sessions.token_id       → mcp_personal_tokens (which credential)
//
// This file pins the chain by:
//   1. Driving a write through MCP
//   2. Reading the produced activity row + its mcp_sessions companion
//   3. Asserting the JOIN resolves to the original PAT user + client name
//
// Without this end-to-end coverage, the chain could quietly break (as
// the actor_principal=null timing bug almost did) and no individual
// unit test would catch it.

const WRITE_SCOPES = ['documents:read', 'documents:write'] as const

async function seedYjs(docname: string, body: string): Promise<void> {
  const ydoc = new Y.Doc()
  ydoc.getText('content').insert(0, body)
  const update = Y.encodeStateAsUpdate(ydoc)
  await testDb().query(
    `INSERT INTO yjs_documents (docname, value, version) VALUES ($1, $2, 'v1')`,
    [docname, Buffer.from(update)]
  )
}

interface ResolvedActor {
  activityAction: string
  actorPrincipal: string
  mcpSessionId: string
  userId: number
  clientName: string | null
  tokenId: string | null
}

async function resolveAuditChain(docId: string): Promise<ResolvedActor | null> {
  const r = await testDb().query<{
    action: string
    actor_principal: string
    user_id: number
    client_name: string | null
    token_id: string | null
    mcp_session_id: string
  }>(
    // Strip the 'mcp:' prefix and JOIN to mcp_sessions in one query —
    // mirrors what `enrichActivityActors` does in the activity repo.
    `SELECT al.action, al.actor_principal,
            ms.user_id, ms.client_name, ms.token_id, ms.mcp_session_id
       FROM activity_log al
       JOIN mcp_sessions ms ON ms.mcp_session_id = SUBSTRING(al.actor_principal FROM 5)
      WHERE al.doc_id = $1
        AND al.actor_principal LIKE 'mcp:%'
      ORDER BY al.id DESC
      LIMIT 1`,
    [docId]
  )
  if (r.rows.length === 0) return null
  const row = r.rows[0]!
  return {
    activityAction: row.action,
    actorPrincipal: row.actor_principal,
    mcpSessionId: row.mcp_session_id,
    userId: row.user_id,
    clientName: row.client_name,
    tokenId: row.token_id
  }
}

describe('MCP audit chain — actor_principal → mcp_sessions → users', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('an MCP edit produces a row whose actor_principal joins back to the PAT user', async () => {
    const user = await createUser({ name: 'Audit User' })
    const doc = await createDoc({ ownerId: user.id })
    await seedYjs(doc.docId, 'content to mutate')

    const { plaintext, tokenId } = await mintPat({
      userId: user.id,
      scopes: WRITE_SCOPES,
      name: 'audit-chain-test'
    })

    const client = mcp(plaintext, { clientName: 'Test Harness vNext' })
    await client.call('replace_text', {
      doc_id: doc.docId,
      old_str: 'content',
      new_str: 'CONTENT'
    })

    // Hocuspocus debounces store events 2-10s; wait conservatively
    // for the activity row to land.
    await new Promise(r => setTimeout(r, 12_000))

    const resolved = await resolveAuditChain(doc.docId)
    expect(resolved, 'activity_log row with mcp:% actor_principal should exist').not.toBeNull()
    expect(resolved!.activityAction).toBe('edit')
    expect(resolved!.userId).toBe(user.id)
    expect(resolved!.clientName).toBe('Test Harness vNext')
    expect(resolved!.tokenId).toBe(tokenId)
    // The session id in the row is the same UUID the harness saw on the
    // initialize response.
    expect(resolved!.mcpSessionId).toBe(client.getSessionId())
  }, 30_000)

  it('different PATs produce different mcp_sessions rows', async () => {
    const user = await createUser()

    const a = await mintPat({ userId: user.id, scopes: WRITE_SCOPES, name: 'pat-a' })
    const b = await mintPat({ userId: user.id, scopes: WRITE_SCOPES, name: 'pat-b' })

    const cA = mcp(a.plaintext, { clientName: 'client-a' })
    const cB = mcp(b.plaintext, { clientName: 'client-b' })

    await cA.initialize()
    await cB.initialize()
    // After initialize each client must have its own session id, and
    // a follow-up call (any tool — pick a cheap read) populates the
    // mcp_sessions row.
    await cA.call('list_my_documents', {})
    await cB.call('list_my_documents', {})

    expect(cA.getSessionId()).not.toBe(cB.getSessionId())

    const r = await testDb().query<{ mcp_session_id: string, client_name: string | null, token_id: string | null }>(
      `SELECT mcp_session_id, client_name, token_id
         FROM mcp_sessions
        WHERE user_id = $1
        ORDER BY id ASC`,
      [user.id]
    )
    // Two rows, one per session. clientName + tokenId differ.
    expect(r.rows.length).toBeGreaterThanOrEqual(2)
    const clientNames = r.rows.map(x => x.client_name).filter(Boolean)
    expect(clientNames).toContain('client-a')
    expect(clientNames).toContain('client-b')
    const tokenIds = r.rows.map(x => x.token_id).filter(Boolean)
    expect(new Set(tokenIds).size).toBeGreaterThanOrEqual(2)
  })
})

describe('MCP session reuse — Mcp-Session-Id is sticky across one client', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('multiple tool calls on one client reuse the same session id', async () => {
    const user = await createUser()
    const { plaintext } = await mintPat({ userId: user.id, scopes: WRITE_SCOPES })
    const client = mcp(plaintext)

    await client.initialize()
    const id1 = client.getSessionId()
    expect(id1).toMatch(/^[0-9a-f-]{36}$/)

    // Three sequential tool calls — toolkit assigns the session id once
    // on initialize, then every subsequent request echoes it via the
    // Mcp-Session-Id header (the harness threads it transparently).
    await client.call('list_my_documents', {})
    await client.call('list_my_documents', {})
    await client.call('list_my_documents', {})

    expect(client.getSessionId()).toBe(id1)
  })
})
