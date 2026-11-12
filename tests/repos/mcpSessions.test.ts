import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { resetDb, testDb } from '../integration/setup/db'
import { createUser } from '../integration/setup/fixtures'
import { mcpSessions, mcpPersonalTokens } from '../../server/db/schema'
import { useDatabase } from '../../server/db/client'
import { useValkey } from '../../server/utils/platform/valkey'
import { issueMcpToken, touchMcpSession } from '../../server/utils/mcp/mcpAuth'
import { asUser } from '../helpers/access'

// DB-backed tests for the `mcp_sessions` audit-attribution table.
// Without this writer + table, `activity_log` rows tagged
// `mcp:{mcpSessionId}` are dead pointers — these tests pin the
// upsert idempotency, throttle behavior, and FK cascade rules that
// make the join chain reliable.

describe('touchMcpSession — first call inserts a row', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('inserts a row with the expected shape', async () => {
    const user = await createUser()
    const issued = await issueMcpToken({
      self: asUser(user.id), name: 't', scopes: ['documents:read']
    })
    const sid = 'mcp-sid-insert'
    // Clear any throttle key so the touch fires immediately.
    const valkey = useValkey()
    await valkey.del(`mcp:session:touch:${sid}`)

    await touchMcpSession({
      mcpSessionId: sid,
      userId: user.id,
      tokenId: issued.tokenId,
      clientName: 'Claude Desktop',
      userAgent: 'TestAgent/1.0'
    })

    const db = useDatabase()
    const rows = await db.select().from(mcpSessions).where(eq(mcpSessions.mcpSessionId, sid))
    expect(rows.length).toBe(1)
    expect(rows[0]!.userId).toBe(user.id)
    expect(rows[0]!.tokenId).toBe(issued.tokenId)
    expect(rows[0]!.clientName).toBe('Claude Desktop')
    expect(rows[0]!.userAgent).toBe('TestAgent/1.0')
    expect(rows[0]!.startedAt).toBeInstanceOf(Date)
    expect(rows[0]!.lastActiveAt).toBeInstanceOf(Date)
  })

  it('subsequent touch (after throttle clears) updates lastActiveAt, not startedAt', async () => {
    const user = await createUser()
    const issued = await issueMcpToken({
      self: asUser(user.id), name: 't', scopes: ['documents:read']
    })
    const sid = 'mcp-sid-update'
    const valkey = useValkey()

    await valkey.del(`mcp:session:touch:${sid}`)
    await touchMcpSession({
      mcpSessionId: sid, userId: user.id, tokenId: issued.tokenId
    })
    const db = useDatabase()
    const first = (await db.select().from(mcpSessions).where(eq(mcpSessions.mcpSessionId, sid)))[0]!
    const firstStarted = first.startedAt
    const firstActive = first.lastActiveAt

    // Wait long enough that the new timestamp differs from the first.
    await new Promise(r => setTimeout(r, 50))

    // Clear throttle + touch again with a new userAgent.
    await valkey.del(`mcp:session:touch:${sid}`)
    await touchMcpSession({
      mcpSessionId: sid, userId: user.id, tokenId: issued.tokenId, userAgent: 'NewAgent/2.0'
    })

    const second = (await db.select().from(mcpSessions).where(eq(mcpSessions.mcpSessionId, sid)))[0]!
    expect(second.startedAt.getTime()).toBe(firstStarted.getTime()) // immutable
    expect(second.lastActiveAt.getTime()).toBeGreaterThanOrEqual(firstActive.getTime())
    // First-writer-wins on userAgent (was null on first call → second
    // call's value should land via COALESCE).
    expect(second.userAgent).toBe('NewAgent/2.0')
  })

  it('first-writer-wins on clientName (later NULL never overwrites)', async () => {
    const user = await createUser()
    const sid = 'mcp-sid-first-wins'
    const valkey = useValkey()
    await valkey.del(`mcp:session:touch:${sid}`)

    await touchMcpSession({
      mcpSessionId: sid, userId: user.id, tokenId: null, clientName: 'Cursor'
    })
    await valkey.del(`mcp:session:touch:${sid}`)
    await touchMcpSession({
      mcpSessionId: sid, userId: user.id, tokenId: null, clientName: null
    })

    const db = useDatabase()
    const row = (await db.select().from(mcpSessions).where(eq(mcpSessions.mcpSessionId, sid)))[0]!
    expect(row.clientName).toBe('Cursor')
  })

  it('Valkey throttle suppresses a too-soon second touch', async () => {
    // Don't clear the throttle key — the second touch should no-op.
    const user = await createUser()
    const sid = 'mcp-sid-throttled'

    await touchMcpSession({
      mcpSessionId: sid, userId: user.id, tokenId: null, clientName: 'First'
    })
    // No valkey.del between → second call is throttled.
    await touchMcpSession({
      mcpSessionId: sid, userId: user.id, tokenId: null, clientName: 'Second'
    })

    const db = useDatabase()
    const rows = await db.select().from(mcpSessions).where(eq(mcpSessions.mcpSessionId, sid))
    expect(rows.length).toBe(1)
    expect(rows[0]!.clientName).toBe('First') // second call didn't fire
  })
})

describe('mcp_sessions — FK cascade rules (the audit-trail contract)', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('deleting the user cascades the session row away', async () => {
    const user = await createUser()
    const sid = 'mcp-sid-user-cascade'
    const valkey = useValkey()
    await valkey.del(`mcp:session:touch:${sid}`)
    await touchMcpSession({ mcpSessionId: sid, userId: user.id, tokenId: null })

    const tdb = testDb()
    await tdb.query('DELETE FROM users WHERE id = $1', [user.id])

    const db = useDatabase()
    const rows = await db.select().from(mcpSessions).where(eq(mcpSessions.mcpSessionId, sid))
    expect(rows.length).toBe(0) // cascade ate the row
  })

  it('hard-deleting the PAT sets token_id to NULL but preserves the session row', async () => {
    // Soft-revocation (revoked_at) doesn't trigger this — it's only
    // the hard DELETE that fires ON DELETE SET NULL. The user-deletion
    // cascade above is the only realistic way a PAT row gets deleted
    // today; this test pins the FK shape so a future direct-delete
    // doesn't break the audit chain.
    const user = await createUser()
    const issued = await issueMcpToken({
      self: asUser(user.id), name: 't', scopes: ['documents:read']
    })
    const sid = 'mcp-sid-token-setnull'
    const valkey = useValkey()
    await valkey.del(`mcp:session:touch:${sid}`)
    await touchMcpSession({
      mcpSessionId: sid, userId: user.id, tokenId: issued.tokenId
    })

    const db = useDatabase()
    await db.delete(mcpPersonalTokens).where(eq(mcpPersonalTokens.tokenId, issued.tokenId))

    const row = (await db.select().from(mcpSessions).where(eq(mcpSessions.mcpSessionId, sid)))[0]
    expect(row).toBeDefined()
    expect(row!.userId).toBe(user.id) // still joinable to the human
    expect(row!.tokenId).toBeNull() // credential pointer cleared
  })
})

describe('mcp_sessions — the audit join chain', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('two tool calls in one session collapse to ONE row (the whole point)', async () => {
    // Mirrors what the middleware does: same mcpSessionId across N
    // requests should produce ONE row, not N. The throttle is what
    // enforces this in practice — within 60s the second call no-ops;
    // beyond 60s the upsert UPDATEs in place.
    const user = await createUser()
    const sid = 'mcp-sid-collapse'
    const valkey = useValkey()
    await valkey.del(`mcp:session:touch:${sid}`)
    await touchMcpSession({ mcpSessionId: sid, userId: user.id, tokenId: null })

    // Simulate the second call AFTER the throttle window. We can't
    // wait 60s in a test, so just clear the throttle key.
    await valkey.del(`mcp:session:touch:${sid}`)
    await touchMcpSession({ mcpSessionId: sid, userId: user.id, tokenId: null })

    const db = useDatabase()
    const rows = await db.select().from(mcpSessions).where(eq(mcpSessions.mcpSessionId, sid))
    expect(rows.length).toBe(1) // UPSERT, not duplicate INSERT
  })

  it('join chain: mcpSessionId → user_id resolves the human', async () => {
    // The forensic question: "given the mcp:{sid} principal stamped
    // on an activity_log row, which human made the call?" This test
    // pins that the JOIN works.
    const user = await createUser()
    const sid = 'mcp-sid-join'
    const valkey = useValkey()
    await valkey.del(`mcp:session:touch:${sid}`)
    await touchMcpSession({ mcpSessionId: sid, userId: user.id, tokenId: null })

    // What the audit-forensics query would do: strip 'mcp:' prefix,
    // look up the session, follow user_id.
    const principal = `mcp:${sid}`
    const idFromPrincipal = principal.replace(/^mcp:/, '')
    const db = useDatabase()
    const row = (await db.select().from(mcpSessions).where(eq(mcpSessions.mcpSessionId, idFromPrincipal)))[0]
    expect(row).toBeDefined()
    expect(row!.userId).toBe(user.id)
  })
})
