import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import { planAccountDeletion } from '../../server/utils/accountDeletionPlan'
import {
  createDoc,
  createUser,
  createWorkspace,
  setMemberRole
} from '../integration/setup/fixtures'

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

describe('planAccountDeletion', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns null for a nonexistent user', async () => {
    expect(await planAccountDeletion(99_999_999)).toBeNull()
  })

  it('classifies workspace fates: cascade vs promote vs remove_member', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const carol = await createUser()

    // (1) Sole-member ws → cascade_delete
    const wsSolo = await createWorkspace(alice.id, { name: 'Solo' })

    // (2) Co-admin ws (alice + bob both admin) → promote_admin
    const wsCoadmin = await createWorkspace(alice.id, { name: 'CoAdmin' })
    await setMemberRole(wsCoadmin.workspaceId, bob.id, 'admin')

    // (3) AdminOnly ws (alice admin, bob editor) → promote_admin (bob)
    const wsAdminOnly = await createWorkspace(alice.id, { name: 'AdminOnly' })
    await setMemberRole(wsAdminOnly.workspaceId, bob.id, 'editor')

    // (4) External ws (carol owns; alice is editor) → remove_member
    const wsExternal = await createWorkspace(carol.id, { name: 'External' })
    await setMemberRole(wsExternal.workspaceId, alice.id, 'editor')

    const plan = await planAccountDeletion(alice.id)
    expect(plan).not.toBeNull()
    const byWs = Object.fromEntries(plan!.workspaces.map(w => [w.workspaceId, w]))

    expect(byWs[wsSolo.workspaceId]).toMatchObject({ kind: 'cascade_delete', name: 'Solo', docCount: 0 })
    expect(byWs[wsCoadmin.workspaceId]).toMatchObject({
      kind: 'promote_admin', name: 'CoAdmin', newAdminUserId: bob.id, newAdminPreviousRole: 'admin'
    })
    expect(byWs[wsAdminOnly.workspaceId]).toMatchObject({
      kind: 'promote_admin', name: 'AdminOnly', newAdminUserId: bob.id, newAdminPreviousRole: 'editor'
    })
    expect(byWs[wsExternal.workspaceId]).toMatchObject({
      kind: 'remove_member', name: 'External', currentRole: 'editor'
    })
  })

  it('counts owned docs (any access mode) but excludes docs owned by others', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const aliceDoc1 = await createDoc({ ownerId: alice.id, title: 'A1' })
    const aliceDoc2 = await createDoc({ ownerId: alice.id, accessMode: 'open-edit', title: 'A2' })
    await createDoc({ ownerId: bob.id, title: 'B' })

    const plan = await planAccountDeletion(alice.id)
    expect(plan!.ownedDocs).toHaveLength(2)
    const titles = plan!.ownedDocs.map(d => d.title).sort()
    expect(titles).toEqual(['A1', 'A2'])
    // Doc ids match what we created.
    expect(plan!.ownedDocs.map(d => d.docId).sort()).toEqual([aliceDoc1.docId, aliceDoc2.docId].sort())
  })

  it('counts comments-to-anonymise excluding those on docs the user owns', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const aliceOwnedDoc = await createDoc({ ownerId: alice.id })
    const bobDoc = await createDoc({ ownerId: bob.id })

    // Comment on alice's own doc — gets purged with the doc, so plan
    // should NOT count it under commentsToAnonymise.
    await insertComment({ docId: aliceOwnedDoc.docId, entryId: 'c1', authorId: alice.id, authorName: alice.name, body: 'self' })
    // Comment on bob's doc — anonymised.
    await insertComment({ docId: bobDoc.docId, entryId: 'c2', authorId: alice.id, authorName: alice.name, body: 'foreign' })
    // Bob's own comment — never touched.
    await insertComment({ docId: bobDoc.docId, entryId: 'c3', authorId: bob.id, authorName: bob.name, body: 'b' })

    const plan = await planAccountDeletion(alice.id)
    expect(plan!.commentsToAnonymise).toBe(1)
  })

  it('reports stripe customer id when set, null otherwise', async () => {
    const alice = await createUser()
    const bob = await createUser()
    await testDb().query(
      `UPDATE users SET stripe_customer_id = 'cus_alice' WHERE id = $1`, [alice.id]
    )
    const planA = await planAccountDeletion(alice.id)
    expect(planA!.stripeCustomerToDelete).toBe('cus_alice')

    const planB = await planAccountDeletion(bob.id)
    expect(planB!.stripeCustomerToDelete).toBeNull()
  })

  it('returns counts for AI usage rows', async () => {
    const alice = await createUser()
    const doc = await createDoc({ ownerId: alice.id })
    await testDb().query(
      `INSERT INTO ai_sessions (session_id, doc_id, initiator_user_id, initiator_name, initiator_color)
       VALUES ('s1', $1, $2, 'A', '#fff')`,
      [doc.docId, alice.id]
    )
    await testDb().query(
      `INSERT INTO ai_session_messages (doc_id, user_id, session_id, kind, body)
       VALUES ($1, $2, 's1', 'user_prompt', '{}'::jsonb)`,
      [doc.docId, alice.id]
    )
    await testDb().query(
      `INSERT INTO ai_usage_period (attributed_to, period_start, interactions_used)
       VALUES ($1, '2025-01-01T00:00:00Z', 5)`,
      [`user:${alice.id}`]
    )

    const plan = await planAccountDeletion(alice.id)
    expect(plan!.aiSessionsToDelete).toBe(1)
    expect(plan!.aiSessionMessagesToDelete).toBe(1)
    expect(plan!.aiUsagePeriodRowsToDelete).toBe(1)
  })

  it('preserves promote ordering: existing admin first, then editor, then viewer', async () => {
    const alice = await createUser()
    const bobAdmin = await createUser()
    const carolEditor = await createUser()
    const daveViewer = await createUser()

    const ws = await createWorkspace(alice.id)
    await setMemberRole(ws.workspaceId, bobAdmin.id, 'admin')
    await setMemberRole(ws.workspaceId, carolEditor.id, 'editor')
    await setMemberRole(ws.workspaceId, daveViewer.id, 'viewer')

    const plan = await planAccountDeletion(alice.id)
    const fate = plan!.workspaces[0]
    expect(fate.kind).toBe('promote_admin')
    expect((fate as { newAdminUserId: number }).newAdminUserId).toBe(bobAdmin.id)
  })
})
