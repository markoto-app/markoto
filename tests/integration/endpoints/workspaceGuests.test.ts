import { beforeEach, describe, expect, it } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { loggedInClient } from '../setup/client'
import { createDoc, createUser, createWorkspace, setMemberRole } from '../setup/fixtures'
import { TEST_BILLING_OFF_BASE_URL } from '../setup/env'
import { clearRecentKicks, waitForKick } from '../setup/syncProbe'

// Workspace guests: a guest sees ONLY the documents shared with
// them: no workspace page, no other document, no knowledge, takes no
// seat, and is capped at 5 per paid seat in a Team / Business
// workspace. Admins and editors share documents with them; admins see
// per-person usage.

const FUTURE = new Date(Date.now() + 30 * 24 * 3600 * 1000)

async function seedSubscription(workspaceId: string, seats: number, adminId: number): Promise<void> {
  await testDb().query(
    `INSERT INTO workspace_subscriptions
       (workspace_id, plan, seats, status, billing_admin_id, stripe_customer_id, stripe_subscription_id, current_period_start, valid_until, currency, interval)
     VALUES ($1, 'team', $2, 'active', $3, 'cus_ws_seed', 'sub_existing_test', now(), $4, 'eur', 'month')`,
    [workspaceId, seats, adminId, FUTURE]
  )
}

interface TokenRes { token: string | null, forbidden: boolean, readOnly: boolean, workspaceRole: string | null, guest?: boolean }

async function tokenFor(userId: number, docId: string): Promise<TokenRes> {
  const res = await (await loggedInClient(userId)).get(`/api/docs/${docId}/token`)
  expect(res.status).toBe(200)
  return await res.json() as TokenRes
}

async function setup() {
  const admin = await createUser({ name: 'Maya Admin' })
  const ws = await createWorkspace(admin.id, { name: 'Launch' })
  const editor = await createUser({ name: 'Ed Editor' })
  await setMemberRole(ws.workspaceId, editor.id, 'editor')
  const guest = await createUser({ name: 'Gus Guest', email: 'gus@client.example' })
  await setMemberRole(ws.workspaceId, guest.id, 'guest')
  const shared = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId, accessMode: 'private', title: 'Proposal' })
  const other = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId, accessMode: 'private', title: 'Internal' })
  return { admin, ws, editor, guest, shared, other }
}

describe('workspace guests: access', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('a guest reaches only shared documents, with the shared access', async () => {
    const { admin, ws, guest, shared, other } = await setup()
    // Nothing shared yet: both documents are closed, the workspace too.
    expect((await tokenFor(guest.id, shared.docId)).forbidden).toBe(true)
    const guestClient = await loggedInClient(guest.id)
    expect((await guestClient.get(`/api/workspaces/${ws.workspaceId}`)).status).toBe(404)
    expect((await guestClient.get(`/api/workspaces/${ws.workspaceId}/knowledge`)).status).toBeGreaterThanOrEqual(403)
    const wsList = await (await guestClient.get('/api/user/workspaces')).json() as Array<{ workspaceId: string }>
    expect(wsList.map(w => w.workspaceId)).not.toContain(ws.workspaceId)

    const adminClient = await loggedInClient(admin.id)
    expect((await adminClient.put(`/api/docs/${shared.docId}/shares`, { userId: guest.id, access: 'view' })).status).toBe(200)
    const view = await tokenFor(guest.id, shared.docId)
    expect(view).toMatchObject({ forbidden: false, readOnly: true, workspaceRole: null, guest: true })
    expect(view.token).toBeTruthy()
    expect((await tokenFor(guest.id, other.docId)).forbidden).toBe(true)

    expect((await adminClient.put(`/api/docs/${shared.docId}/shares`, { userId: guest.id, access: 'edit' })).status).toBe(200)
    expect(await tokenFor(guest.id, shared.docId)).toMatchObject({ forbidden: false, readOnly: false })

    // Listed under "Shared with you".
    const mine = await (await guestClient.get('/api/user/shared-documents')).json() as Array<{ docId: string, access: string, workspaceName: string }>
    expect(mine).toEqual([expect.objectContaining({ docId: shared.docId, access: 'edit', workspaceName: 'Launch' })])

    // A guest can't share further, nor see the workspace's members to mention.
    expect((await guestClient.get(`/api/docs/${shared.docId}/shares`)).status).toBe(403)
    const mentionable = await (await guestClient.get(`/api/docs/${shared.docId}/mentionable-users`)).json() as { users: unknown[] }
    expect(mentionable.users).toEqual([])
    // Nor the presence roster, while a real member still gets it.
    const guestRoster = await guestClient.get(`/api/docs/${shared.docId}/members`)
    expect(guestRoster.status).toBe(200)
    expect(await guestRoster.json()).toEqual({ members: [] })
    const memberRoster = await (await adminClient.get(`/api/docs/${shared.docId}/members`)).json() as { members: Array<{ userId: number }> }
    expect(memberRoster.members.map(m => m.userId)).toContain(admin.id)

    // Unsharing closes it again.
    expect((await adminClient.delete(`/api/docs/${shared.docId}/shares/${guest.id}`)).status).toBe(200)
    expect((await tokenFor(guest.id, shared.docId)).forbidden).toBe(true)
    expect(await (await guestClient.get('/api/user/shared-documents')).json()).toEqual([])
  })

  it('editors share too; only with guests of the document\'s workspace; viewers and outsiders can\'t', async () => {
    const { ws, editor, guest, shared } = await setup()
    const viewer = await createUser()
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
    const outsider = await createUser()
    const editorClient = await loggedInClient(editor.id)

    const list = await (await editorClient.get(`/api/docs/${shared.docId}/shares`)).json() as { shares: unknown[], guests: Array<{ userId: number }> }
    expect(list.guests.map(g => g.userId)).toEqual([guest.id])
    expect((await editorClient.put(`/api/docs/${shared.docId}/shares`, { userId: guest.id, access: 'view' })).status).toBe(200)
    // A member (not a guest) or an outsider is not a share target.
    expect((await editorClient.put(`/api/docs/${shared.docId}/shares`, { userId: viewer.id, access: 'view' })).status).toBe(404)
    expect((await editorClient.put(`/api/docs/${shared.docId}/shares`, { userId: outsider.id, access: 'view' })).status).toBe(404)
    expect((await editorClient.put(`/api/docs/${shared.docId}/shares`, { userId: guest.id, access: 'admin' })).status).toBe(400)
    expect((await (await loggedInClient(viewer.id)).put(`/api/docs/${shared.docId}/shares`, { userId: guest.id, access: 'edit' })).status).toBe(403)
    expect((await (await loggedInClient(outsider.id)).get(`/api/docs/${shared.docId}/shares`)).status).toBe(403)

    const audit = await testDb().query(`SELECT action, workspace_id FROM audit_log WHERE action = 'doc.shared'`)
    expect(audit.rows).toEqual([{ action: 'doc.shared', workspace_id: ws.workspaceId }])
  })

  it('moving the document out of the workspace, or the guest leaving, ends the shares', async () => {
    const { admin, ws, guest, shared, other } = await setup()
    const adminClient = await loggedInClient(admin.id)
    await adminClient.put(`/api/docs/${shared.docId}/shares`, { userId: guest.id, access: 'edit' })
    await adminClient.put(`/api/docs/${other.docId}/shares`, { userId: guest.id, access: 'view' })

    const target = await createWorkspace(admin.id)
    expect((await adminClient.patch(`/api/docs/${other.docId}/workspace`, { workspaceId: target.workspaceId })).status).toBe(200)
    expect((await tokenFor(guest.id, other.docId)).forbidden).toBe(true)

    // The guest leaves on their own.
    expect((await (await loggedInClient(guest.id)).delete(`/api/workspaces/${ws.workspaceId}/members/${guest.id}`)).status).toBe(200)
    const left = await testDb().query('SELECT count(*)::int AS n FROM document_shares WHERE user_id = $1', [guest.id])
    expect(left.rows[0].n).toBe(0)
    expect((await tokenFor(guest.id, shared.docId)).forbidden).toBe(true)
  })

  it('moving a shared document out of the workspace closes the guests\' open editor connections', async () => {
    const { admin, ws, editor, guest, shared } = await setup()
    const second = await createUser({ name: 'Gia Guest' })
    await setMemberRole(ws.workspaceId, second.id, 'guest')
    const adminClient = await loggedInClient(admin.id)
    await adminClient.put(`/api/docs/${shared.docId}/shares`, { userId: guest.id, access: 'edit' })
    await adminClient.put(`/api/docs/${shared.docId}/shares`, { userId: second.id, access: 'view' })
    await clearRecentKicks()

    const target = await createWorkspace(admin.id)
    expect((await adminClient.patch(`/api/docs/${shared.docId}/workspace`, { workspaceId: target.workspaceId })).status).toBe(200)
    // Same kick as unsharing: every guest whose share went, for that document.
    for (const id of [guest.id, second.id]) {
      const kick = await waitForKick(k => k.userId === String(id))
      expect(kick.docIds).toEqual([shared.docId])
    }
    // Members keep their access through the workspace, so nobody else is kicked.
    expect(await waitForKick(k => k.userId === String(editor.id), 300).catch(() => null)).toBeNull()
  })

  it('a guest with an edit share can\'t duplicate the document into the workspace', async () => {
    const { admin, ws, guest, shared } = await setup()
    await (await loggedInClient(admin.id)).put(`/api/docs/${shared.docId}/shares`, { userId: guest.id, access: 'edit' })
    const guestClient = await loggedInClient(guest.id)

    // Default target (the source's workspace) and an explicit one alike.
    for (const body of [{}, { workspaceId: ws.workspaceId }]) {
      const res = await guestClient.post(`/api/docs/${shared.docId}/duplicate`, body)
      expect(res.status).toBe(403)
      expect((await res.json() as { data?: { code?: string } }).data?.code).toBe('workspace/guest-cannot-create')
    }
    const docs = await testDb().query('SELECT count(*)::int AS n FROM documents WHERE workspace_id = $1', [ws.workspaceId])
    expect(docs.rows[0].n).toBe(2)
    const owned = await testDb().query('SELECT count(*)::int AS n FROM documents WHERE owner_id = $1', [guest.id])
    expect(owned.rows[0].n).toBe(0)
  })

  it('a guest has no workspace role to change, and isn\'t counted as a member', async () => {
    const { admin, ws, guest } = await setup()
    const adminClient = await loggedInClient(admin.id)
    const patch = await adminClient.patch(`/api/workspaces/${ws.workspaceId}/members/${guest.id}`, { role: 'editor' })
    expect(patch.status).toBe(409)
    const detail = await (await adminClient.get(`/api/workspaces/${ws.workspaceId}`)).json() as { members: Array<{ userId: number, role: string }>, workspace: { guests: { available: boolean } } }
    expect(detail.members.find(m => m.userId === guest.id)?.role).toBe('guest')
    expect(detail.workspace.guests).toEqual({ available: true })
  })
})

describe('workspace guests: invitations', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('a guest invite is accepted as a guest and needs no seat', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    for (let i = 0; i < 2; i++) await setMemberRole(ws.workspaceId, (await createUser()).id, 'editor')
    await seedSubscription(ws.workspaceId, 3, admin.id)
    const adminClient = await loggedInClient(admin.id)
    // Every seat is taken: a member invite is refused, a guest invite isn't.
    expect((await adminClient.post(`/api/workspaces/${ws.workspaceId}/members`, { email: 'member@example.com', role: 'editor' })).status).toBe(409)
    expect((await adminClient.post(`/api/workspaces/${ws.workspaceId}/members`, { email: 'client@example.com', role: 'guest' })).status).toBe(202)

    const client = await createUser({ email: 'client@example.com' })
    const clientApi = await loggedInClient(client.id)
    const invites = await (await clientApi.get('/api/user/invites')).json() as Array<{ inviteId: string, role: string }>
    expect(invites[0]?.role).toBe('guest')
    const accept = await clientApi.post(`/api/user/invites/${invites[0]?.inviteId}/accept`)
    expect(await accept.json()).toMatchObject({ workspaceId: ws.workspaceId, role: 'guest' })
    expect((await clientApi.get(`/api/workspaces/${ws.workspaceId}`)).status).toBe(404)

    const billing = await (await adminClient.get(`/api/workspaces/${ws.workspaceId}/billing`)).json() as { seatsUsed?: number, subscription?: { seatsUsed?: number } }
    expect(billing.seatsUsed ?? billing.subscription?.seatsUsed).toBe(3)
  })

  it('at most 5 guests per paid seat (guests + open guest invites)', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    await seedSubscription(ws.workspaceId, 3, admin.id)
    for (let i = 0; i < 14; i++) await setMemberRole(ws.workspaceId, (await createUser()).id, 'guest')
    const adminClient = await loggedInClient(admin.id)
    expect((await adminClient.post(`/api/workspaces/${ws.workspaceId}/members`, { email: 'g15@example.com', role: 'guest' })).status).toBe(202)
    const capped = await adminClient.post(`/api/workspaces/${ws.workspaceId}/members`, { email: 'g16@example.com', role: 'guest' })
    expect(capped.status).toBe(409)
    expect((await capped.json() as { data?: { code?: string, limit?: number } }).data).toMatchObject({ code: 'workspace/guest-cap', limit: 15 })
  })

  it('markoto.app free plan: no guests', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const client = await loggedInClient(admin.id, undefined, TEST_BILLING_OFF_BASE_URL)
    const res = await client.post(`/api/workspaces/${ws.workspaceId}/members`, { email: 'client@example.com', role: 'guest' })
    expect(res.status).toBe(409)
    expect((await res.json() as { data?: { code?: string } }).data?.code).toBe('plan/feature-unavailable')
    const detail = await (await client.get(`/api/workspaces/${ws.workspaceId}`)).json() as { workspace: { guests: { available: boolean } } }
    expect(detail.workspace.guests).toEqual({ available: false })
  })
})

describe('workspace usage', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('admins see per-person documents, knowledge, images; guests with their shared documents', async () => {
    const { admin, ws, editor, guest, shared } = await setup()
    await createDoc({ ownerId: editor.id, workspaceId: ws.workspaceId })
    await (await loggedInClient(admin.id)).put(`/api/docs/${shared.docId}/shares`, { userId: guest.id, access: 'view' })

    expect((await (await loggedInClient(editor.id)).get(`/api/workspaces/${ws.workspaceId}/usage`)).status).toBe(403)
    expect((await (await loggedInClient(guest.id)).get(`/api/workspaces/${ws.workspaceId}/usage`)).status).toBe(404)
    const res = await (await loggedInClient(admin.id)).get(`/api/workspaces/${ws.workspaceId}/usage`)
    expect(res.status).toBe(200)
    const body = await res.json() as { aiBudgetShared: boolean, members: Array<{ userId: number, role: string, documents: number, sharedDocuments: number, aiSpendUsd: number | null }> }
    expect(body.aiBudgetShared).toBe(false)
    const byId = Object.fromEntries(body.members.map(m => [m.userId, m]))
    expect(byId[admin.id]).toMatchObject({ role: 'admin', documents: 2, aiSpendUsd: null })
    expect(byId[editor.id]).toMatchObject({ role: 'editor', documents: 1 })
    expect(byId[guest.id]).toMatchObject({ role: 'guest', documents: 0, sharedDocuments: 1, aiSpendUsd: null })
    expect(body.members.map(m => m.role)).toEqual(['admin', 'editor', 'guest'])
  })
})

describe('workspace guests: single sign-on and account deletion', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('an enforced SSO connection doesn\'t lock guests out of documents shared with them', async () => {
    const { admin, ws, editor, guest, shared } = await setup()
    await (await loggedInClient(admin.id)).put(`/api/docs/${shared.docId}/shares`, { userId: guest.id, access: 'view' })
    await testDb().query(
      `INSERT INTO sso_connections (id, workspace_id, protocol, status, default_role) VALUES ('ssoc-guest', $1, 'oidc', 'active', 'editor')`,
      [ws.workspaceId]
    )
    expect((await tokenFor(guest.id, shared.docId)).forbidden).toBe(false)
    // The member without an SSO grant is locked out of the private doc.
    expect((await tokenFor(editor.id, shared.docId)).forbidden).toBe(true)
  })

  it('a guest is never promoted when the last admin deletes their account', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const guest = await createUser()
    await setMemberRole(ws.workspaceId, guest.id, 'guest')
    const preview = await (await loggedInClient(admin.id)).get('/api/user/deletion-preview')
    const fates = (await preview.json() as { workspaces: Array<{ workspaceId: string, kind: string }> }).workspaces
    expect(fates.find(f => f.workspaceId === ws.workspaceId)?.kind).toBe('cascade_delete')
  })
})
