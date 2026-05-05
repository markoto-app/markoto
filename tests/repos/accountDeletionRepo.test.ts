import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import {
  anonymiseCommentsByAuthor,
  deleteAiSessionsByUser,
  deleteAiUsagePeriodByUser,
  deleteThemesByUser,
  deleteUserRow,
  listMembershipsForUser,
  listOtherMembers,
  listOwnedDocIds,
  promoteWorkspaceAdmin,
  removeAllMemberships
} from '../../server/repos/accountDeletionRepo'
import {
  createDoc,
  createUser,
  createWorkspace,
  setMemberRole
} from '../integration/setup/fixtures'

// Repo-level tests for the deletion-cascade helpers. These hit the DB
// directly and exercise the SQL shape (FK ordering, returning clauses,
// anonymisation pattern, idempotency). The executor itself is tested
// at a higher level — see `accountDeletionExecute.test.ts`.

async function insertComment(args: {
  docId: string
  entryId: string
  authorId: number
  authorName: string
  body: string
}): Promise<void> {
  const db = testDb()
  await db.query(
    `INSERT INTO document_comments (doc_id, entry_id, author_id, author_name, body, created_at_ms, updated_at_ms)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
    [args.docId, args.entryId, args.authorId, args.authorName, args.body]
  )
}

describe('anonymiseCommentsByAuthor', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('updates author_id to NULL and author_name to "[deleted user]"', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const doc = await createDoc({ ownerId: bob.id })
    await insertComment({
      docId: doc.docId, entryId: 'e1', authorId: alice.id,
      authorName: alice.name, body: 'hello'
    })
    await insertComment({
      docId: doc.docId, entryId: 'e2', authorId: bob.id,
      authorName: bob.name, body: 'reply'
    })

    const updated = await anonymiseCommentsByAuthor(alice.id)
    expect(updated).toBe(1)

    const rows = await testDb().query<{ author_id: number | null, author_name: string, body: string }>(
      `SELECT author_id, author_name, body FROM document_comments ORDER BY entry_id`
    )
    // Alice's comment anonymised, body intact.
    expect(rows.rows[0]).toEqual({ author_id: null, author_name: '[deleted user]', body: 'hello' })
    // Bob's comment untouched.
    expect(rows.rows[1]).toEqual({ author_id: bob.id, author_name: bob.name, body: 'reply' })
  })

  it('returns 0 when the user has no comments', async () => {
    const u = await createUser()
    expect(await anonymiseCommentsByAuthor(u.id)).toBe(0)
  })

  it('is idempotent — re-running on already-anonymised state returns 0', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const doc = await createDoc({ ownerId: bob.id })
    await insertComment({
      docId: doc.docId, entryId: 'e1', authorId: alice.id,
      authorName: alice.name, body: 'x'
    })
    expect(await anonymiseCommentsByAuthor(alice.id)).toBe(1)
    expect(await anonymiseCommentsByAuthor(alice.id)).toBe(0)
  })
})

describe('promoteWorkspaceAdmin', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('repoints workspaces.owner_id and sets the new admin\'s role', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const ws = await createWorkspace(alice.id)
    await setMemberRole(ws.workspaceId, bob.id, 'editor')

    await promoteWorkspaceAdmin(ws.workspaceId, alice.id, bob.id)

    const wsRow = await testDb().query<{ owner_id: number }>(
      `SELECT owner_id FROM workspaces WHERE workspace_id = $1`,
      [ws.workspaceId]
    )
    expect(wsRow.rows[0].owner_id).toBe(bob.id)

    const memberRow = await testDb().query<{ role: string }>(
      `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [ws.workspaceId, bob.id]
    )
    expect(memberRow.rows[0].role).toBe('admin')
  })

  it('does not touch owner_id when the outgoing user is not the owner', async () => {
    const alice = await createUser() // owner
    const bob = await createUser()   // co-admin
    const carol = await createUser() // editor we'll promote when bob leaves
    const ws = await createWorkspace(alice.id)
    await setMemberRole(ws.workspaceId, bob.id, 'admin')
    await setMemberRole(ws.workspaceId, carol.id, 'editor')

    await promoteWorkspaceAdmin(ws.workspaceId, bob.id, carol.id)

    const wsRow = await testDb().query<{ owner_id: number }>(
      `SELECT owner_id FROM workspaces WHERE workspace_id = $1`,
      [ws.workspaceId]
    )
    expect(wsRow.rows[0].owner_id).toBe(alice.id) // unchanged

    const memberRow = await testDb().query<{ role: string }>(
      `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [ws.workspaceId, carol.id]
    )
    expect(memberRow.rows[0].role).toBe('admin')
  })

  it('is idempotent if the new admin already has admin role', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const ws = await createWorkspace(alice.id)
    await setMemberRole(ws.workspaceId, bob.id, 'admin')

    await promoteWorkspaceAdmin(ws.workspaceId, alice.id, bob.id)
    await promoteWorkspaceAdmin(ws.workspaceId, alice.id, bob.id)

    const wsRow = await testDb().query<{ owner_id: number }>(
      `SELECT owner_id FROM workspaces WHERE workspace_id = $1`,
      [ws.workspaceId]
    )
    expect(wsRow.rows[0].owner_id).toBe(bob.id)
  })
})

describe('removeAllMemberships', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('drops every workspace_members row for the user and returns ws ids', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const ws1 = await createWorkspace(bob.id)
    const ws2 = await createWorkspace(bob.id)
    const ws3 = await createWorkspace(alice.id) // alice is admin here too
    await setMemberRole(ws1.workspaceId, alice.id, 'editor')
    await setMemberRole(ws2.workspaceId, alice.id, 'viewer')

    const removed = await removeAllMemberships(alice.id)
    expect(removed.sort()).toEqual(
      [ws1.workspaceId, ws2.workspaceId, ws3.workspaceId].sort()
    )

    const remaining = await testDb().query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM workspace_members WHERE user_id = $1`,
      [alice.id]
    )
    expect(Number(remaining.rows[0].count)).toBe(0)
  })

  it('returns empty array when the user has no memberships', async () => {
    const u = await createUser()
    expect(await removeAllMemberships(u.id)).toEqual([])
  })
})

describe('deleteAiSessionsByUser', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('removes every ai_sessions row for the user', async () => {
    const u = await createUser()
    const u2 = await createUser()
    const doc = await createDoc({ ownerId: u.id })
    const doc2 = await createDoc({ ownerId: u2.id })
    await testDb().query(
      `INSERT INTO ai_sessions (session_id, doc_id, initiator_user_id, initiator_name, initiator_color)
       VALUES ('s1', $1, $2, 'A', '#fff')`,
      [doc.docId, u.id]
    )
    await testDb().query(
      `INSERT INTO ai_sessions (session_id, doc_id, initiator_user_id, initiator_name, initiator_color)
       VALUES ('s2', $1, $2, 'B', '#fff')`,
      [doc2.docId, u2.id]
    )

    const removed = await deleteAiSessionsByUser(u.id)
    expect(removed).toBe(1)

    const remaining = await testDb().query<{ count: string }>(`SELECT COUNT(*) AS count FROM ai_sessions`)
    expect(Number(remaining.rows[0].count)).toBe(1)
  })
})

describe('deleteAiUsagePeriodByUser', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('removes user-keyed rows but keeps workspace-keyed rows', async () => {
    const u = await createUser()
    const ws = await createWorkspace(u.id)
    const periodStart = '2025-01-01T00:00:00Z'
    await testDb().query(
      `INSERT INTO ai_usage_period (attributed_to, period_start, interactions_used)
       VALUES ($1, $2, 5)`,
      [`user:${u.id}`, periodStart]
    )
    await testDb().query(
      `INSERT INTO ai_usage_period (attributed_to, period_start, interactions_used)
       VALUES ($1, $2, 7)`,
      [`workspace:${ws.workspaceId}`, periodStart]
    )

    const removed = await deleteAiUsagePeriodByUser(u.id)
    expect(removed).toBe(1)

    const remaining = await testDb().query<{ attributed_to: string }>(
      `SELECT attributed_to FROM ai_usage_period`
    )
    expect(remaining.rows.length).toBe(1)
    expect(remaining.rows[0].attributed_to).toContain('workspace:')
  })
})

describe('deleteThemesByUser', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('removes themes owned by the user', async () => {
    const alice = await createUser()
    const bob = await createUser()
    await testDb().query(
      `INSERT INTO themes (theme_id, user_id, name, theme) VALUES ('t1', $1, 'A', '{}'::jsonb)`,
      [alice.id]
    )
    await testDb().query(
      `INSERT INTO themes (theme_id, user_id, name, theme) VALUES ('t2', $1, 'B', '{}'::jsonb)`,
      [bob.id]
    )

    const removed = await deleteThemesByUser(alice.id)
    expect(removed).toBe(1)

    const remaining = await testDb().query<{ count: string }>(`SELECT COUNT(*) AS count FROM themes`)
    expect(Number(remaining.rows[0].count)).toBe(1)
  })
})

describe('listOwnedDocIds', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns only docs the user owns, not docs they collaborate on', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const aliceDoc = await createDoc({ ownerId: alice.id })
    await createDoc({ ownerId: bob.id })
    await createDoc({ ownerId: null }) // anonymous

    const owned = await listOwnedDocIds(alice.id)
    expect(owned).toEqual([aliceDoc.docId])
  })
})

describe('listMembershipsForUser', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns role + ownerId per workspace', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const ws1 = await createWorkspace(alice.id)
    const ws2 = await createWorkspace(bob.id)
    await setMemberRole(ws2.workspaceId, alice.id, 'editor')

    const m = await listMembershipsForUser(alice.id)
    expect(m.length).toBe(2)
    const byWs = Object.fromEntries(m.map(r => [r.workspaceId, r]))
    expect(byWs[ws1.workspaceId]).toMatchObject({ role: 'admin', ownerId: alice.id })
    expect(byWs[ws2.workspaceId]).toMatchObject({ role: 'editor', ownerId: bob.id })
  })
})

describe('listOtherMembers', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns members ordered by joinedAt asc, excluding the given user', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const carol = await createUser()
    const ws = await createWorkspace(alice.id) // alice joinedAt = T0

    // Backdate alice's joinedAt so bob (who joins later) is genuinely
    // longer-tenured-than-bob ordering test stays meaningful.
    await testDb().query(
      `UPDATE workspace_members SET joined_at = NOW() - INTERVAL '10 days' WHERE workspace_id = $1 AND user_id = $2`,
      [ws.workspaceId, alice.id]
    )
    await setMemberRole(ws.workspaceId, bob.id, 'editor')
    await setMemberRole(ws.workspaceId, carol.id, 'viewer')

    const others = await listOtherMembers(ws.workspaceId, alice.id)
    expect(others.map(o => o.userId)).toEqual([bob.id, carol.id])
    expect(others[0]!.role).toBe('editor')
    expect(others[1]!.role).toBe('viewer')
  })

  it('returns empty when the user is sole member', async () => {
    const alice = await createUser()
    const ws = await createWorkspace(alice.id)
    expect(await listOtherMembers(ws.workspaceId, alice.id)).toEqual([])
  })
})

describe('deleteUserRow', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('deletes the row and SET-NULLs activity_log.user_id while keeping user_name', async () => {
    const u = await createUser()
    // Use a doc owned by ANOTHER user so the activity_log row stays
    // around after we delete u (whose owned docs we'd otherwise have
    // to clean up first via the executor).
    const other = await createUser()
    const doc = await createDoc({ ownerId: other.id })
    await testDb().query(
      `INSERT INTO activity_log (doc_id, user_id, user_name, action) VALUES ($1, $2, 'Alice', 'edit')`,
      [doc.docId, u.id]
    )

    await deleteUserRow(u.id)

    const userRow = await testDb().query(`SELECT id FROM users WHERE id = $1`, [u.id])
    expect(userRow.rows.length).toBe(0)

    // activity_log row survives — user_id NULL, user_name preserved.
    const activityRow = await testDb().query<{ user_id: number | null, user_name: string }>(
      `SELECT user_id, user_name FROM activity_log WHERE doc_id = $1`,
      [doc.docId]
    )
    expect(activityRow.rows[0]).toEqual({ user_id: null, user_name: 'Alice' })
  })

  it('throws when the user is already gone', async () => {
    await expect(deleteUserRow(99_999_999)).rejects.toThrow(/already gone/)
  })
})
