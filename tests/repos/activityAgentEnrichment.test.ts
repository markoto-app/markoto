import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import { createUser, createDoc } from '../integration/setup/fixtures'
import { listRecentActivity } from '../../server/repos/activity'
import { useDatabase } from '../../server/db/client'
import { issueMcpToken, touchMcpSession } from '../../server/utils/mcp/mcpAuth'
import { useValkey } from '../../server/utils/platform/valkey'
import { aiSessions } from '../../server/db/schema'
import { asUser, docAs } from '../helpers/access'

// Pin the unified-attribution enrichment chain end-to-end against
// a real DB. Mirrors what the sync-server + agentic loop would
// stamp into `activity_log.actor_principal` for the two agent
// kinds, then asserts that `listRecentActivity` resolves the human
// initiator + (for MCP) the client name.
//
// The smoke test for the live sync server verified the data path
// to `activity_log`; this file pins the read-side enrichment so
// the join chain doesn't silently regress.

async function insertRawActivity(args: {
  docId: string
  userId: number | null
  userName: string | null
  actorPrincipal: string | null
}): Promise<void> {
  const db = testDb()
  await db.query(
    `INSERT INTO activity_log (doc_id, user_id, user_name, actor_principal, action)
     VALUES ($1, $2, $3, $4, 'edit')`,
    [args.docId, args.userId, args.userName, args.actorPrincipal]
  )
}

describe('listRecentActivity: agent enrichment', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('human edits get null agent fields (no actor_principal)', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })
    await insertRawActivity({
      docId: doc.docId,
      userId: user.id,
      userName: user.name,
      actorPrincipal: null
    })

    const rows = await listRecentActivity(docAs(doc.docId), 10)
    expect(rows.length).toBe(1)
    expect(rows[0]!.agentKind).toBeNull()
    expect(rows[0]!.agentInitiatorName).toBeNull()
    expect(rows[0]!.agentClientName).toBeNull()
    // Human row: userName drives display via the row's user_id JOIN.
    expect(rows[0]!.userName).toBe(user.name)
    expect(rows[0]!.userId).toBe(user.id)
  })

  it('MCP edit resolves to the human + client_name via mcp_sessions', async () => {
    const user = await createUser({ name: 'Joel' })
    const doc = await createDoc({ ownerId: user.id })
    const issued = await issueMcpToken({
      self: asUser(user.id), name: 't', scopes: ['documents:write']
    })
    const sid = 'mcp-sid-enrich'
    // Touch the session so mcp_sessions has the row to JOIN.
    const valkey = useValkey()
    await valkey.del(`mcp:session:touch:${sid}`)
    await touchMcpSession({
      mcpSessionId: sid,
      userId: user.id,
      tokenId: issued.tokenId,
      clientName: 'Claude Desktop',
      userAgent: 'claude-desktop/1.0'
    })

    // Insert the activity row exactly like the (rebuilt) sync server
    // would: actor_principal carries the synthetic principal, user_id
    // is null, user_name is the friendly literal.
    await insertRawActivity({
      docId: doc.docId,
      userId: null,
      userName: 'MCP',
      actorPrincipal: `mcp:${sid}`
    })

    const rows = await listRecentActivity(docAs(doc.docId), 10)
    expect(rows.length).toBe(1)
    expect(rows[0]!.agentKind).toBe('mcp')
    expect(rows[0]!.agentInitiatorUserId).toBe(user.id)
    expect(rows[0]!.agentInitiatorName).toBe('Joel')
    expect(rows[0]!.agentClientName).toBe('Claude Desktop')
    // Raw row fields preserved.
    expect(rows[0]!.userName).toBe('MCP')
    expect(rows[0]!.userId).toBeNull()
  })

  it('AI loop edit resolves to the human via ai_sessions', async () => {
    const user = await createUser({ name: 'Joel' })
    const doc = await createDoc({ ownerId: user.id })
    const aiSid = 'ai-sid-enrich'
    const db = useDatabase()
    await db.insert(aiSessions).values({
      sessionId: aiSid,
      docId: doc.docId,
      initiatorUserId: user.id,
      initiatorName: user.name,
      initiatorColor: '#ABC'
    })

    await insertRawActivity({
      docId: doc.docId,
      userId: null,
      userName: 'markoto',
      actorPrincipal: `ai:assistant:${aiSid}`
    })

    const rows = await listRecentActivity(docAs(doc.docId), 10)
    expect(rows.length).toBe(1)
    expect(rows[0]!.agentKind).toBe('ai')
    expect(rows[0]!.agentInitiatorUserId).toBe(user.id)
    expect(rows[0]!.agentInitiatorName).toBe('Joel')
    // AI rows carry no client_name, only MCP does.
    expect(rows[0]!.agentClientName).toBeNull()
  })

  it('MCP row falls back to user_agent when client_name is null', async () => {
    // Models the case where the initialize-time clientInfo.name stash
    // missed (Valkey down at init, etc.). The renderer reads
    // `agentClientName` and would show "via {ua}" instead of just
    // "via MCP": degrades gracefully.
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })
    const sid = 'mcp-sid-no-clientname'
    const valkey = useValkey()
    await valkey.del(`mcp:session:touch:${sid}`)
    await touchMcpSession({
      mcpSessionId: sid,
      userId: user.id,
      tokenId: null,
      clientName: null,
      userAgent: 'cursor-mcp/0.5'
    })

    await insertRawActivity({
      docId: doc.docId,
      userId: null,
      userName: 'MCP',
      actorPrincipal: `mcp:${sid}`
    })

    const rows = await listRecentActivity(docAs(doc.docId), 10)
    expect(rows[0]!.agentClientName).toBe('cursor-mcp/0.5')
  })

  it('agent row whose session was swept renders with null initiator (graceful)', async () => {
    // Models the case where `mcp_sessions` was pruned by the 90-day
    // sweeper but the activity_log row still references the dead
    // session. The renderer falls back to the row's userName.
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })
    await insertRawActivity({
      docId: doc.docId,
      userId: null,
      userName: 'MCP',
      actorPrincipal: 'mcp:long-gone-session'
    })

    const rows = await listRecentActivity(docAs(doc.docId), 10)
    expect(rows.length).toBe(1)
    expect(rows[0]!.agentKind).toBe('mcp') // we still know it WAS MCP
    expect(rows[0]!.agentInitiatorUserId).toBeNull() // can't resolve
    expect(rows[0]!.agentInitiatorName).toBeNull()
    expect(rows[0]!.agentClientName).toBeNull()
    // The renderer uses entry.userName ('MCP') as the displayed
    // name: see ActivityFeed.vue's `displayName()` helper.
  })

  it('mixed batch: one human + one AI + one MCP, all enriched correctly', async () => {
    const human = await createUser({ name: 'Human Joel' })
    const aiInitiator = await createUser({ name: 'AI Initiator' })
    const mcpInitiator = await createUser({ name: 'MCP Initiator' })
    const doc = await createDoc({ ownerId: human.id })

    // Seed sessions
    const db = useDatabase()
    await db.insert(aiSessions).values({
      sessionId: 'mix-ai',
      docId: doc.docId,
      initiatorUserId: aiInitiator.id,
      initiatorName: aiInitiator.name,
      initiatorColor: '#DEF'
    })
    const valkey = useValkey()
    await valkey.del('mcp:session:touch:mix-mcp')
    await touchMcpSession({
      mcpSessionId: 'mix-mcp',
      userId: mcpInitiator.id,
      tokenId: null,
      clientName: 'Cursor'
    })

    // Three rows
    await insertRawActivity({ docId: doc.docId, userId: human.id, userName: human.name, actorPrincipal: null })
    await insertRawActivity({ docId: doc.docId, userId: null, userName: 'markoto', actorPrincipal: 'ai:assistant:mix-ai' })
    await insertRawActivity({ docId: doc.docId, userId: null, userName: 'MCP', actorPrincipal: 'mcp:mix-mcp' })

    const rows = await listRecentActivity(docAs(doc.docId), 10)
    expect(rows.length).toBe(3)
    // Most-recent-first
    const byPrincipal = new Map(rows.map(r => [r.actorPrincipal, r]))
    expect(byPrincipal.get('mcp:mix-mcp')?.agentKind).toBe('mcp')
    expect(byPrincipal.get('mcp:mix-mcp')?.agentInitiatorName).toBe('MCP Initiator')
    expect(byPrincipal.get('mcp:mix-mcp')?.agentClientName).toBe('Cursor')
    expect(byPrincipal.get('ai:assistant:mix-ai')?.agentKind).toBe('ai')
    expect(byPrincipal.get('ai:assistant:mix-ai')?.agentInitiatorName).toBe('AI Initiator')
    expect(byPrincipal.get(null)?.agentKind).toBeNull()
    expect(byPrincipal.get(null)?.userName).toBe(human.name)
  })
})
