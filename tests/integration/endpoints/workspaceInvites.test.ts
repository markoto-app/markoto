import { describe, it, expect, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import { createUser, createWorkspace, setMemberRole } from '../setup/fixtures'

// Workspace invitations: inviting by email creates a PENDING invite; the
// invitee becomes a member only by accepting it. The invite endpoint
// answers identically for registered and unregistered addresses and
// never returns profile data.

async function memberRole(wsId: string, userId: number): Promise<string | null> {
  const r = await testDb().query<{ role: string }>(
    'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
    [wsId, userId]
  )
  return r.rows[0]?.role ?? null
}

async function inviteRows(wsId: string): Promise<Array<{ email: string, role: string, token_hash: string | null }>> {
  const r = await testDb().query<{ email: string, role: string, token_hash: string | null }>(
    'SELECT email, role, token_hash FROM workspace_invites WHERE workspace_id = $1 ORDER BY id',
    [wsId]
  )
  return r.rows
}

/** Insert an invite with a known emailed token (the email itself is stubbed). */
async function insertInviteWithToken(args: {
  wsId: string
  email: string
  role: 'admin' | 'editor' | 'viewer'
  token: string
  inviterId: number
  expiresAt?: Date
}): Promise<string> {
  const inviteId = `inv${Math.random().toString(36).slice(2, 14)}`
  await testDb().query(
    `INSERT INTO workspace_invites (invite_id, workspace_id, email, role, invited_by_user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      inviteId,
      args.wsId,
      args.email,
      args.role,
      args.inviterId,
      createHash('sha256').update(args.token).digest('hex'),
      args.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000)
    ]
  )
  return inviteId
}

const TOKEN = 'invite-token-abcdefghijklmnopqrstuvwxyz0123456'

describe('POST /api/workspaces/:wsId/members (invite)', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('creates a pending invite and does NOT add a registered user as a member', async () => {
    const admin = await createUser()
    const invitee = await createUser({ email: 'invitee@test.local' })
    const ws = await createWorkspace(admin.id)
    const client = await loggedInClient(admin.id)

    const res = await client.post(`/api/workspaces/${ws.workspaceId}/members`, {
      email: 'invitee@test.local',
      role: 'admin'
    })
    expect(res.status).toBe(202)
    expect(await memberRole(ws.workspaceId, invitee.id)).toBeNull()
    expect(await inviteRows(ws.workspaceId)).toMatchObject([{ email: 'invitee@test.local', role: 'admin' }])
  })

  it('answers identically for registered and unregistered addresses, with no profile data', async () => {
    const admin = await createUser()
    await createUser({ email: 'known@test.local', name: 'Known Person' })
    const ws = await createWorkspace(admin.id)
    const client = await loggedInClient(admin.id)

    const known = await client.post(`/api/workspaces/${ws.workspaceId}/members`, { email: 'known@test.local' })
    const unknown = await client.post(`/api/workspaces/${ws.workspaceId}/members`, { email: 'nobody@test.local' })

    expect(known.status).toBe(202)
    expect(unknown.status).toBe(202)
    const knownBody = await known.json()
    const unknownBody = await unknown.json()
    expect(knownBody).toEqual(unknownBody)
    expect(JSON.stringify(knownBody)).not.toContain('Known Person')
    expect(knownBody).not.toHaveProperty('userId')
    expect(knownBody).not.toHaveProperty('avatarUrl')
  })

  it('normalises the address and defaults the role to editor', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const client = await loggedInClient(admin.id)
    const res = await client.post(`/api/workspaces/${ws.workspaceId}/members`, { email: '  Alice@Test.Local ' })
    expect(res.status).toBe(202)
    expect(await inviteRows(ws.workspaceId)).toMatchObject([{ email: 'alice@test.local', role: 'editor' }])
  })

  it('re-inviting the same address refreshes the single open invite', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const client = await loggedInClient(admin.id)
    await client.post(`/api/workspaces/${ws.workspaceId}/members`, { email: 'sam@test.local', role: 'viewer' })
    await client.post(`/api/workspaces/${ws.workspaceId}/members`, { email: 'SAM@test.local', role: 'editor' })
    expect(await inviteRows(ws.workspaceId)).toMatchObject([{ email: 'sam@test.local', role: 'editor' }])
  })

  it('409 when the address already belongs to a member', async () => {
    const admin = await createUser()
    const member = await createUser({ email: 'member@test.local' })
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, member.id, 'viewer')
    const client = await loggedInClient(admin.id)
    const res = await client.post(`/api/workspaces/${ws.workspaceId}/members`, { email: 'member@test.local' })
    expect(res.status).toBe(409)
    expect(await inviteRows(ws.workspaceId)).toEqual([])
  })

  it('caps open invites per workspace', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    for (let i = 0; i < 50; i++) {
      await testDb().query(
        `INSERT INTO workspace_invites (invite_id, workspace_id, email, role, invited_by_user_id, expires_at)
         VALUES ($1, $2, $3, 'editor', $4, NOW() + interval '1 day')`,
        [`cap-${i}-xxxxxxxx`, ws.workspaceId, `p${i}@test.local`, admin.id]
      )
    }
    const client = await loggedInClient(admin.id)
    const res = await client.post(`/api/workspaces/${ws.workspaceId}/members`, { email: 'one-more@test.local' })
    expect(res.status).toBe(409)
    expect((await res.json() as { data?: { code?: string } }).data?.code).toBe('workspace/invite-cap')
  })

  it('rejects invalid role / malformed email (400)', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const client = await loggedInClient(admin.id)
    expect((await client.post(`/api/workspaces/${ws.workspaceId}/members`, { email: 'x@test.local', role: 'godmode' })).status).toBe(400)
    expect((await client.post(`/api/workspaces/${ws.workspaceId}/members`, { email: 'not-an-email' })).status).toBe(400)
  })

  it('a missing, non-text or malformed address is workspace/invalid-email', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const client = await loggedInClient(admin.id)
    for (const body of [{}, { email: 5 }, { email: null }, { email: 'not-an-email' }]) {
      const res = await client.post(`/api/workspaces/${ws.workspaceId}/members`, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect((await res.json() as { data?: { code?: string } }).data?.code, JSON.stringify(body)).toBe('workspace/invalid-email')
    }
  })

  it('editors cannot invite (403); non-members get 404', async () => {
    const admin = await createUser()
    const editor = await createUser()
    const stranger = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    expect((await (await loggedInClient(editor.id)).post(`/api/workspaces/${ws.workspaceId}/members`, { email: 'a@test.local' })).status).toBe(403)
    expect((await (await loggedInClient(stranger.id)).post(`/api/workspaces/${ws.workspaceId}/members`, { email: 'a@test.local' })).status).toBe(404)
  })
})

describe('invitee: GET /api/user/invites + accept / decline', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('lists invites addressed to the account email; accepting creates the membership with the invited role', async () => {
    const admin = await createUser({ name: 'Maya' })
    const invitee = await createUser({ email: 'Invitee@Test.Local' })
    const ws = await createWorkspace(admin.id, { name: 'Launch' })
    await (await loggedInClient(admin.id)).post(`/api/workspaces/${ws.workspaceId}/members`, {
      email: 'invitee@test.local',
      role: 'viewer'
    })

    const client = await loggedInClient(invitee.id)
    const list = await client.get('/api/user/invites')
    expect(list.status).toBe(200)
    const invites = await list.json() as Array<{ inviteId: string, workspaceName: string, role: string, invitedByName: string }>
    expect(invites).toHaveLength(1)
    expect(invites[0]).toMatchObject({ workspaceName: 'Launch', role: 'viewer', invitedByName: 'Maya' })

    const accept = await client.post(`/api/user/invites/${invites[0]?.inviteId}/accept`)
    expect(accept.status).toBe(200)
    expect(await accept.json()).toMatchObject({ workspaceId: ws.workspaceId, role: 'viewer' })
    expect(await memberRole(ws.workspaceId, invitee.id)).toBe('viewer')
    expect(await inviteRows(ws.workspaceId)).toEqual([])
    // The workspace now shows in the invitee's list.
    const mine = await (await client.get('/api/user/workspaces')).json() as Array<{ workspaceId: string }>
    expect(mine.map(w => w.workspaceId)).toContain(ws.workspaceId)
  })

  it('declining deletes the invite without a membership', async () => {
    const admin = await createUser()
    const invitee = await createUser({ email: 'dec@test.local' })
    const ws = await createWorkspace(admin.id)
    await (await loggedInClient(admin.id)).post(`/api/workspaces/${ws.workspaceId}/members`, { email: 'dec@test.local' })
    const client = await loggedInClient(invitee.id)
    const [invite] = await (await client.get('/api/user/invites')).json() as Array<{ inviteId: string }>
    const res = await client.post(`/api/user/invites/${invite?.inviteId}/decline`)
    expect(res.status).toBe(200)
    expect(await memberRole(ws.workspaceId, invitee.id)).toBeNull()
    expect(await inviteRows(ws.workspaceId)).toEqual([])
  })

  it('another user cannot accept an invite addressed to someone else (404)', async () => {
    const admin = await createUser()
    await createUser({ email: 'target@test.local' })
    const intruder = await createUser({ email: 'intruder@test.local' })
    const ws = await createWorkspace(admin.id)
    await (await loggedInClient(admin.id)).post(`/api/workspaces/${ws.workspaceId}/members`, { email: 'target@test.local' })
    const inviteId = (await testDb().query<{ invite_id: string }>('SELECT invite_id FROM workspace_invites')).rows[0]?.invite_id
    expect(inviteId).toBeTruthy()

    const client = await loggedInClient(intruder.id)
    expect(await (await client.get('/api/user/invites')).json()).toEqual([])
    expect((await client.post(`/api/user/invites/${inviteId}/accept`)).status).toBe(404)
    expect((await client.post(`/api/user/invites/${inviteId}/decline`)).status).toBe(404)
    expect(await memberRole(ws.workspaceId, intruder.id)).toBeNull()
    expect(await inviteRows(ws.workspaceId)).toHaveLength(1)
  })

  it('an expired invite can no longer be accepted', async () => {
    const admin = await createUser()
    const invitee = await createUser({ email: 'late@test.local' })
    const ws = await createWorkspace(admin.id)
    const inviteId = await insertInviteWithToken({
      wsId: ws.workspaceId, email: 'late@test.local', role: 'editor', token: TOKEN, inviterId: admin.id,
      expiresAt: new Date(Date.now() - 1000)
    })
    const client = await loggedInClient(invitee.id)
    expect(await (await client.get('/api/user/invites')).json()).toEqual([])
    expect((await client.post(`/api/user/invites/${inviteId}/accept`)).status).toBe(404)
    expect(await memberRole(ws.workspaceId, invitee.id)).toBeNull()
  })

  it('accepting keeps an existing membership role untouched', async () => {
    const admin = await createUser()
    const invitee = await createUser({ email: 'already@test.local' })
    const ws = await createWorkspace(admin.id)
    const inviteId = await insertInviteWithToken({ wsId: ws.workspaceId, email: 'already@test.local', role: 'admin', token: TOKEN, inviterId: admin.id })
    await setMemberRole(ws.workspaceId, invitee.id, 'viewer')
    const res = await (await loggedInClient(invitee.id)).post(`/api/user/invites/${inviteId}/accept`)
    expect(res.status).toBe(200)
    expect(await memberRole(ws.workspaceId, invitee.id)).toBe('viewer')
  })

  it('anonymous callers are rejected (401)', async () => {
    expect((await anonClient().get('/api/user/invites')).status).toBe(401)
    expect((await anonClient().post('/api/user/invites/by-token', { token: TOKEN, action: 'accept' })).status).toBe(401)
  })
})

describe('POST /api/user/invites/by-token (email link)', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('the emailed token lets the signed-in recipient accept, whatever their account email', async () => {
    const admin = await createUser()
    const recipient = await createUser({ email: 'other-address@test.local' })
    const ws = await createWorkspace(admin.id)
    await insertInviteWithToken({ wsId: ws.workspaceId, email: 'work@test.local', role: 'editor', token: TOKEN, inviterId: admin.id })

    const res = await (await loggedInClient(recipient.id)).post('/api/user/invites/by-token', { token: TOKEN, action: 'accept' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ workspaceId: ws.workspaceId })
    expect(await memberRole(ws.workspaceId, recipient.id)).toBe('editor')
  })

  it('the token is single-use', async () => {
    const admin = await createUser()
    const a = await createUser()
    const b = await createUser()
    const ws = await createWorkspace(admin.id)
    await insertInviteWithToken({ wsId: ws.workspaceId, email: 'x@test.local', role: 'editor', token: TOKEN, inviterId: admin.id })
    expect((await (await loggedInClient(a.id)).post('/api/user/invites/by-token', { token: TOKEN, action: 'accept' })).status).toBe(200)
    expect((await (await loggedInClient(b.id)).post('/api/user/invites/by-token', { token: TOKEN, action: 'accept' })).status).toBe(404)
    expect(await memberRole(ws.workspaceId, b.id)).toBeNull()
  })

  it('decline by token deletes the invite; a wrong token is 404', async () => {
    const admin = await createUser()
    const u = await createUser()
    const ws = await createWorkspace(admin.id)
    await insertInviteWithToken({ wsId: ws.workspaceId, email: 'y@test.local', role: 'editor', token: TOKEN, inviterId: admin.id })
    const client = await loggedInClient(u.id)
    expect((await client.post('/api/user/invites/by-token', { token: `${TOKEN}x`, action: 'accept' })).status).toBe(404)
    expect((await client.post('/api/user/invites/by-token', { token: TOKEN, action: 'decline' })).status).toBe(200)
    expect(await inviteRows(ws.workspaceId)).toEqual([])
    expect(await memberRole(ws.workspaceId, u.id)).toBeNull()
  })
})

describe('admin: GET + DELETE /api/workspaces/:wsId/invites', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('admins see the typed address and role; revoking removes the invite', async () => {
    const admin = await createUser({ name: 'Maya' })
    const ws = await createWorkspace(admin.id)
    const client = await loggedInClient(admin.id)
    await client.post(`/api/workspaces/${ws.workspaceId}/members`, { email: 'Pending@Test.Local', role: 'viewer' })

    const list = await client.get(`/api/workspaces/${ws.workspaceId}/invites`)
    expect(list.status).toBe(200)
    const invites = await list.json() as Array<{ inviteId: string, email: string, role: string, invitedByName: string }>
    expect(invites).toHaveLength(1)
    expect(invites[0]).toMatchObject({ email: 'pending@test.local', role: 'viewer', invitedByName: 'Maya' })
    expect(Object.keys(invites[0] ?? {}).sort()).toEqual(['createdAt', 'email', 'expiresAt', 'inviteId', 'invitedByName', 'role'])

    const del = await client.delete(`/api/workspaces/${ws.workspaceId}/invites/${invites[0]?.inviteId}`)
    expect(del.status).toBe(200)
    expect(await inviteRows(ws.workspaceId)).toEqual([])
  })

  it('non-admins cannot list or revoke; another workspace\'s invite id is 404', async () => {
    const admin = await createUser()
    const editor = await createUser()
    const otherAdmin = await createUser()
    const ws = await createWorkspace(admin.id)
    const otherWs = await createWorkspace(otherAdmin.id)
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    const inviteId = await insertInviteWithToken({ wsId: ws.workspaceId, email: 'p@test.local', role: 'editor', token: TOKEN, inviterId: admin.id })

    const editorClient = await loggedInClient(editor.id)
    expect((await editorClient.get(`/api/workspaces/${ws.workspaceId}/invites`)).status).toBe(403)
    expect((await editorClient.delete(`/api/workspaces/${ws.workspaceId}/invites/${inviteId}`)).status).toBe(403)

    const otherClient = await loggedInClient(otherAdmin.id)
    expect((await otherClient.delete(`/api/workspaces/${otherWs.workspaceId}/invites/${inviteId}`)).status).toBe(404)
    expect(await inviteRows(ws.workspaceId)).toHaveLength(1)
  })
})
