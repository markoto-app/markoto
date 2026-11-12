import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import {
  createDoc,
  createUser,
  createWorkspace,
  setMemberRole
} from '../integration/setup/fixtures'
import { first } from '../helpers/assert'

// Mock the side-effects that talk to S3 / sync-server / Stripe — none
// are reachable in the repos test environment. The executor's logic
// (which tables get touched, what gets anonymised, what gets promoted)
// is fully testable without them.

// Called with the job's delete proof for the document.
const deleteDocumentMock = vi.fn<(doc: { docId: string }) => Promise<void>>(async () => {})
const deleteKnowledgeArtifactMock = vi.fn(async () => {})
const stripeCustomersDelMock = vi.fn(async () => ({ id: 'cus_x', deleted: true }))

vi.mock('../../server/utils/documents/documentLifecycle', () => ({
  deleteDocument: deleteDocumentMock
}))

vi.mock('../../server/utils/knowledge/knowledgeAccess', () => ({
  deleteKnowledgeArtifact: deleteKnowledgeArtifactMock
}))

vi.mock('../../server/utils/billing/stripeClient', () => ({
  useStripeClient: () => ({
    customers: { del: stripeCustomersDelMock }
  })
}))

// Import AFTER the mocks so the executor binds the mocked symbols.
const { executeAccountDeletion } = await import('../../server/utils/privacy/accountDeletionExecute')

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

async function insertWaitlistRow(email: string, userId: number | null): Promise<void> {
  await testDb().query(
    `INSERT INTO waitlist_signups (email, locale, consent_version, consent_text_id, user_id, confirm_token_hash, confirm_token_expires_at, unsubscribe_token_hash, confirmed_at)
     VALUES ($1, 'en', 1, 'waitlist.consentLabel', $2, NULL, NULL, $3, NOW())`,
    [email, userId, `unsub-hash-${email}`]
  )
}

describe('executeAccountDeletion: full graph', () => {
  beforeEach(async () => {
    await resetDb()
    deleteDocumentMock.mockClear()
    deleteKnowledgeArtifactMock.mockClear()
    stripeCustomersDelMock.mockClear()
    // Make `deleteDocument` actually drop the documents row in the DB
    // so the user-row FK can succeed. The other side-effects (S3 + sync
    // notify) are fine to no-op in tests.
    deleteDocumentMock.mockImplementation(async ({ docId }) => {
      const db = testDb()
      // Mirror what deleteDocDbRows does, in FK-safe order.
      await db.query(`DELETE FROM activity_log WHERE doc_id = $1`, [docId])
      await db.query(`DELETE FROM uploads WHERE doc_id = $1`, [docId])
      await db.query(`DELETE FROM document_comments WHERE doc_id = $1`, [docId])
      await db.query(`DELETE FROM ai_session_messages WHERE doc_id = $1`, [docId])
      await db.query(`DELETE FROM documents WHERE doc_id = $1`, [docId])
    })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('hard-deletes the user row and runs every cascade branch', async () => {
    // Billing on so the Stripe-customer step runs (it's skipped when
    // billing is off — see the dedicated case below).
    vi.stubEnv('NUXT_BILLING_ENABLED', 'true')
    // Build the test graph
    const alice = await createUser()
    const bob = await createUser()
    const carol = await createUser()

    // Stripe customer id so we exercise the Stripe del branch.
    await testDb().query(
      `UPDATE users SET stripe_customer_id = 'cus_alice' WHERE id = $1`,
      [alice.id]
    )

    // (1) Sole-member workspace owned by alice → cascade-delete.
    const wsSolo = await createWorkspace(alice.id, { name: 'Solo' })
    const soloDoc = await createDoc({ ownerId: alice.id, workspaceId: wsSolo.workspaceId })

    // (2) Co-admin workspace where alice + bob both admin → promote bob.
    //     Owner is alice; expected: ownerId reassigned to bob.
    const wsCoadmin = await createWorkspace(alice.id, { name: 'CoAdmin' })
    await setMemberRole(wsCoadmin.workspaceId, bob.id, 'admin')

    // (3) Workspace alice admins; bob is editor → promote bob (longest-
    //     tenured non-admin).
    const wsAdminOnly = await createWorkspace(alice.id, { name: 'AdminOnly' })
    await setMemberRole(wsAdminOnly.workspaceId, bob.id, 'editor')

    // (4) Workspace owned by carol; alice is editor → just remove
    //     alice's membership row.
    const wsExternal = await createWorkspace(carol.id, { name: 'External' })
    await setMemberRole(wsExternal.workspaceId, alice.id, 'editor')

    // (5) Standalone owned doc (no workspace).
    const standaloneDoc = await createDoc({ ownerId: alice.id })

    // (6) Comments authored by alice on carol's doc → anonymise.
    const carolDoc = await createDoc({ ownerId: carol.id })
    await insertComment({ docId: carolDoc.docId, entryId: 'c1', authorId: alice.id, authorName: alice.name, body: 'Alice was here' })
    await insertComment({ docId: carolDoc.docId, entryId: 'c2', authorId: carol.id, authorName: carol.name, body: 'Carol replied' })
    // Activity rows on carol's doc: alice's name snapshot must go, carol's stays.
    await testDb().query(
      `INSERT INTO activity_log (doc_id, user_id, user_name, action) VALUES ($1, $2, $3, 'edit'), ($1, $4, $5, 'edit')`,
      [carolDoc.docId, alice.id, alice.name, carol.id, carol.name]
    )

    // (7) AI sessions + messages + usage period.
    const aiDoc = await createDoc({ ownerId: alice.id })
    await testDb().query(
      `INSERT INTO ai_sessions (session_id, doc_id, initiator_user_id, initiator_name, initiator_color)
       VALUES ('s-alice', $1, $2, 'Alice', '#fff')`,
      [aiDoc.docId, alice.id]
    )
    await testDb().query(
      `INSERT INTO ai_session_messages (doc_id, user_id, session_id, kind, body)
       VALUES ($1, $2, 's-alice', 'user_prompt', $3::jsonb)`,
      [aiDoc.docId, alice.id, JSON.stringify({ text: 'hi' })]
    )

    // (8) Saved theme.
    await testDb().query(
      `INSERT INTO themes (theme_id, user_id, name, theme) VALUES ('t1', $1, 'Mine', '{}'::jsonb)`,
      [alice.id]
    )

    // (9) Audit log entry recording an earlier action by alice (so we
    //     can verify SET NULL on actor_user_id post-deletion).
    await testDb().query(
      `INSERT INTO audit_log (actor_user_id, scope, scope_id, action) VALUES ($1, 'user', $2, 'doc.deleted')`,
      [alice.id, String(alice.id)]
    )

    // (10) Bring-your-own-key AI provider config (encrypted key at rest).
    await testDb().query(
      `INSERT INTO user_ai_providers (user_id, capability, base_url, model, api_key_encrypted, api_key_last4)
       VALUES ($1, 'chat', 'https://api.mistral.ai/v1', 'mistral-small-2603', 'v1:x:y:z', 'abcd')`,
      [alice.id]
    )

    // Execute
    const result = await executeAccountDeletion({ userId: alice.id })

    // Assertions
    // User row is gone.
    const userRow = await testDb().query(`SELECT id FROM users WHERE id = $1`, [alice.id])
    expect(userRow.rows.length).toBe(0)

    // BYOK provider config (and its encrypted key) is gone.
    const providerRows = await testDb().query(`SELECT 1 FROM user_ai_providers WHERE user_id = $1`, [alice.id])
    expect(providerRows.rows.length).toBe(0)

    // Solo workspace + its doc gone.
    const soloWs = await testDb().query(
      `SELECT workspace_id FROM workspaces WHERE workspace_id = $1`, [wsSolo.workspaceId]
    )
    expect(soloWs.rows.length).toBe(0)
    const soloDocRow = await testDb().query(
      `SELECT doc_id FROM documents WHERE doc_id = $1`, [soloDoc.docId]
    )
    expect(soloDocRow.rows.length).toBe(0)

    // Co-admin workspace survived; ownerId is now bob.
    const coadminWs = await testDb().query<{ owner_id: number }>(
      `SELECT owner_id FROM workspaces WHERE workspace_id = $1`, [wsCoadmin.workspaceId]
    )
    expect(coadminWs.rows.length).toBe(1)
    expect(first(coadminWs.rows).owner_id).toBe(bob.id)

    // AdminOnly workspace survived; bob is now admin.
    const adminOnlyMembers = await testDb().query<{ user_id: number, role: string }>(
      `SELECT user_id, role FROM workspace_members WHERE workspace_id = $1`,
      [wsAdminOnly.workspaceId]
    )
    expect(adminOnlyMembers.rows).toHaveLength(1)
    expect(adminOnlyMembers.rows[0]).toEqual({ user_id: bob.id, role: 'admin' })

    // External workspace: alice's row gone, carol still admin.
    const externalMembers = await testDb().query<{ user_id: number, role: string }>(
      `SELECT user_id, role FROM workspace_members WHERE workspace_id = $1 ORDER BY user_id`,
      [wsExternal.workspaceId]
    )
    expect(externalMembers.rows).toHaveLength(1)
    expect(first(externalMembers.rows).user_id).toBe(carol.id)

    // Standalone doc gone.
    const standaloneRow = await testDb().query(
      `SELECT doc_id FROM documents WHERE doc_id = $1`, [standaloneDoc.docId]
    )
    expect(standaloneRow.rows.length).toBe(0)

    // Comments on carol's doc: alice anonymised; carol's intact.
    const carolComments = await testDb().query<{
      entry_id: string
      author_id: number | null
      author_name: string
      body: string
    }>(
      `SELECT entry_id, author_id, author_name, body FROM document_comments WHERE doc_id = $1 ORDER BY entry_id`,
      [carolDoc.docId]
    )
    expect(carolComments.rows[0]).toEqual({
      entry_id: 'c1', author_id: null, author_name: '[deleted user]', body: 'Alice was here'
    })
    expect(carolComments.rows[1]).toEqual({
      entry_id: 'c2', author_id: carol.id, author_name: carol.name, body: 'Carol replied'
    })

    // Activity on carol's doc: alice's row is detached AND nameless (the
    // feed shows "Anonymous"); carol's row is untouched.
    const carolActivity = await testDb().query<{ user_id: number | null, user_name: string | null }>(
      `SELECT user_id, user_name FROM activity_log WHERE doc_id = $1 ORDER BY id`,
      [carolDoc.docId]
    )
    expect(carolActivity.rows).toEqual([
      { user_id: null, user_name: null },
      { user_id: carol.id, user_name: carol.name }
    ])

    // AI sessions cleared. (LiteLLM owns spend state; virtual-key revocation is exercised in the unit tests for
    // `executeAccountDeletion`.)
    const aiSessions = await testDb().query(`SELECT session_id FROM ai_sessions`)
    expect(aiSessions.rows.length).toBe(0)

    // Theme gone.
    const themesLeft = await testDb().query(`SELECT theme_id FROM themes WHERE user_id = $1`, [alice.id])
    expect(themesLeft.rows.length).toBe(0)

    // Audit log row from earlier survives, anonymised.
    const auditRow = await testDb().query<{ actor_user_id: number | null, action: string, scope_id: string }>(
      `SELECT actor_user_id, action, scope_id FROM audit_log WHERE action = 'doc.deleted' AND scope_id = $1`,
      [String(alice.id)]
    )
    expect(auditRow.rows.length).toBe(1)
    expect(first(auditRow.rows).actor_user_id).toBeNull()

    // Audit log: account.delete_executed row landed BEFORE the user
    // row was dropped, so the FK SET NULL has fired and actor_user_id
    // is also null but the metadata + scope_id remain.
    const finalRow = await testDb().query<{
      actor_user_id: number | null
      scope: string
      scope_id: string
      action: string
      metadata: { summary?: Record<string, number | boolean> } | null
    }>(
      `SELECT actor_user_id, scope, scope_id, action, metadata FROM audit_log WHERE action = 'account.delete_executed' AND scope_id = $1`,
      [String(alice.id)]
    )
    expect(finalRow.rows.length).toBe(1)
    expect(first(finalRow.rows).scope).toBe('user')
    expect(first(finalRow.rows).actor_user_id).toBeNull()
    const summary = first(finalRow.rows).metadata?.summary
    expect(summary).toBeTruthy()
    expect(summary!.commentsAnonymised).toBe(1)
    expect(summary!.activityAnonymised).toBe(1)
    expect(summary!.workspacesCascadeDeleted).toBe(1)
    expect(summary!.workspacesPromoted).toBe(2) // co-admin + admin-only
    expect(summary!.themesDeleted).toBe(1)
    expect(summary!.aiProvidersDeleted).toBe(1)
    expect(summary!.aiSessionsDeleted).toBe(1)
    expect(summary!.stripeCustomerDeleted).toBe(true)

    // Stripe del was called with alice's customer id.
    expect(stripeCustomersDelMock).toHaveBeenCalledWith('cus_alice')

    // Result summary shape.
    expect(result.summary.commentsAnonymised).toBe(1)
    expect(result.summary.stripeCustomerDeleted).toBe(true)
  })

  it('is idempotent — running on an already-deleted user is a no-op', async () => {
    const alice = await createUser()
    const result1 = await executeAccountDeletion({ userId: alice.id })
    expect(result1.summary.aiSessionsDeleted).toBe(0)
    // Second run on a now-missing user
    const result2 = await executeAccountDeletion({ userId: alice.id })
    expect(result2.summary).toMatchObject({
      ownedDocsDeleted: 0,
      workspacesCascadeDeleted: 0,
      stripeCustomerDeleted: false
    })
  })

  it('billing off: skips the Stripe step cleanly even when a customer id is set', async () => {
    vi.stubEnv('NUXT_BILLING_ENABLED', 'false')
    const alice = await createUser()
    await testDb().query(
      `UPDATE users SET stripe_customer_id = 'cus_alice' WHERE id = $1`,
      [alice.id]
    )
    const result = await executeAccountDeletion({ userId: alice.id })
    expect(stripeCustomersDelMock).not.toHaveBeenCalled()
    expect(result.summary.stripeCustomerDeleted).toBe(false)
    const userRow = await testDb().query(`SELECT id FROM users WHERE id = $1`, [alice.id])
    expect(userRow.rows).toHaveLength(0)
  })

  it('deletes the user\'s linked waitlist sign-up, leaves other people\'s alone', async () => {
    const alice = await createUser()
    const bob = await createUser()
    await insertWaitlistRow('alice@example.com', alice.id)
    await insertWaitlistRow('bob@example.com', bob.id)
    await insertWaitlistRow('anon@example.com', null)

    await executeAccountDeletion({ userId: alice.id })

    const rows = await testDb().query<{ email: string }>(
      `SELECT email FROM waitlist_signups ORDER BY email`
    )
    expect(rows.rows.map(r => r.email)).toEqual(['anon@example.com', 'bob@example.com'])
  })

  it('deletes invitations addressed to the user; keeps invites they sent (inviter nulled)', async () => {
    const alice = await createUser({ email: 'Alice@Example.com' })
    const bob = await createUser()
    const bobWs = await createWorkspace(bob.id)
    const aliceAndBobWs = await createWorkspace(bob.id)
    await setMemberRole(aliceAndBobWs.workspaceId, alice.id, 'admin')
    await testDb().query(
      `INSERT INTO workspace_invites (invite_id, workspace_id, email, role, invited_by_user_id, expires_at)
       VALUES ('to-alice-1', $1, 'alice@example.com', 'editor', $2, NOW() + interval '7 days'),
              ('by-alice-1', $3, 'carol@example.com', 'editor', $4, NOW() + interval '7 days')`,
      [bobWs.workspaceId, bob.id, aliceAndBobWs.workspaceId, alice.id]
    )

    const { summary } = await executeAccountDeletion({ userId: alice.id })

    expect(summary.workspaceInvitesDeleted).toBe(1)
    const rows = await testDb().query<{ invite_id: string, invited_by_user_id: number | null }>(
      `SELECT invite_id, invited_by_user_id FROM workspace_invites ORDER BY invite_id`
    )
    expect(rows.rows).toEqual([{ invite_id: 'by-alice-1', invited_by_user_id: null }])
  })

  it('skips Stripe del when no customer id is set', async () => {
    const alice = await createUser()
    await executeAccountDeletion({ userId: alice.id })
    expect(stripeCustomersDelMock).not.toHaveBeenCalled()
  })

  it('preserves co-admin workspace when user is admin but not owner', async () => {
    const alice = await createUser()
    const bob = await createUser()
    // Bob owns the workspace; alice is co-admin.
    const ws = await createWorkspace(bob.id)
    await setMemberRole(ws.workspaceId, alice.id, 'admin')

    await executeAccountDeletion({ userId: alice.id })

    // Workspace + bob still admin, owner unchanged.
    const wsRow = await testDb().query<{ owner_id: number }>(
      `SELECT owner_id FROM workspaces WHERE workspace_id = $1`, [ws.workspaceId]
    )
    expect(first(wsRow.rows).owner_id).toBe(bob.id)
    const members = await testDb().query<{ user_id: number, role: string }>(
      `SELECT user_id, role FROM workspace_members WHERE workspace_id = $1`,
      [ws.workspaceId]
    )
    expect(members.rows).toHaveLength(1)
    expect(members.rows[0]).toEqual({ user_id: bob.id, role: 'admin' })
  })
})

describe('executeAccountDeletion: Team / Business billing admin', () => {
  beforeEach(async () => {
    await resetDb()
    deleteDocumentMock.mockClear()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  async function subscribe(workspaceId: string, billingAdminId: number): Promise<void> {
    await testDb().query(
      `INSERT INTO workspace_subscriptions (workspace_id, plan, seats, status, billing_admin_id, valid_until)
       VALUES ($1, 'team', 3, 'active', $2, now() + interval '30 days')`,
      [workspaceId, billingAdminId]
    )
  }

  async function billingAdminOf(workspaceId: string): Promise<number | null | undefined> {
    return (await testDb().query('SELECT billing_admin_id FROM workspace_subscriptions WHERE workspace_id = $1', [workspaceId])).rows[0]?.billing_admin_id
  }

  it('hands the role to the longest-serving other admin', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const carol = await createUser()
    const ws = await createWorkspace(alice.id)
    await setMemberRole(ws.workspaceId, carol.id, 'editor')
    await setMemberRole(ws.workspaceId, bob.id, 'admin')
    await subscribe(ws.workspaceId, alice.id)

    const { summary } = await executeAccountDeletion({ userId: alice.id })
    expect(summary.billingAdminHandovers).toBe(1)
    expect(await billingAdminOf(ws.workspaceId)).toBe(bob.id)
    const audit = (await testDb().query(`SELECT action, after FROM audit_log WHERE scope = 'billing' AND scope_id = $1`, [ws.workspaceId])).rows
    expect(audit).toContainEqual({ action: 'workspace.billing_admin_changed', after: { billingAdminId: bob.id } })
  })

  it('an editor promoted to admin by the deletion becomes the billing admin', async () => {
    const alice = await createUser()
    const dave = await createUser()
    const ws = await createWorkspace(alice.id)
    await setMemberRole(ws.workspaceId, dave.id, 'editor')
    await subscribe(ws.workspaceId, alice.id)

    await executeAccountDeletion({ userId: alice.id })
    expect(await billingAdminOf(ws.workspaceId)).toBe(dave.id)
  })

  it('a sole-member workspace goes with the account, subscription row included', async () => {
    const alice = await createUser()
    const ws = await createWorkspace(alice.id)
    await subscribe(ws.workspaceId, alice.id)

    const { summary } = await executeAccountDeletion({ userId: alice.id })
    expect(summary.billingAdminHandovers).toBe(0)
    expect(await billingAdminOf(ws.workspaceId)).toBeUndefined()
  })
})
