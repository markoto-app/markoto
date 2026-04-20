import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import {
  createDoc,
  createUser,
  createWorkspace,
  setMemberRole
} from '../setup/fixtures'

// Workspace CRUD + invite flow. Covers the remaining authz gates in
// /api/workspaces — creation, rename, delete, and invite-by-email.

async function workspaceExists(wsId: string): Promise<boolean> {
  const db = testDb()
  const r = await db.query('SELECT 1 FROM workspaces WHERE workspace_id = $1', [wsId])
  return r.rowCount === 1
}

async function countDocs(wsId: string): Promise<number> {
  const db = testDb()
  const r = await db.query<{ c: string }>(
    'SELECT COUNT(*) AS c FROM documents WHERE workspace_id = $1',
    [wsId]
  )
  return Number(r.rows[0]?.c ?? 0)
}

describe('POST /api/workspaces', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('creates a workspace and auto-enrols creator as admin', async () => {
    const user = await createUser()
    const client = await loggedInClient(user.id)
    const res = await client.post('/api/workspaces', { name: 'Test Space' })
    expect(res.status).toBe(200)
    const body = await res.json() as { workspaceId: string }
    expect(body.workspaceId).toBeTruthy()

    // Verify the members table has them as admin.
    const db = testDb()
    const member = await db.query<{ role: string }>(
      'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [body.workspaceId, user.id]
    )
    expect(member.rows[0]?.role).toBe('admin')
  })

  it('rejects anonymous caller (401)', async () => {
    const res = await anonClient().post('/api/workspaces', { name: 'Test' })
    expect(res.status).toBe(401)
  })
})

describe('DELETE /api/workspaces/:wsId', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('admin can delete their workspace', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const client = await loggedInClient(admin.id)
    const res = await client.delete(`/api/workspaces/${ws.workspaceId}`)
    expect(res.status).toBe(200)
    expect(await workspaceExists(ws.workspaceId)).toBe(false)
  })

  it('cascade-deletes all docs in the workspace', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId, accessMode: 'private' })
    await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId, accessMode: 'private' })
    const client = await loggedInClient(admin.id)
    const res = await client.delete(`/api/workspaces/${ws.workspaceId}`)
    expect(res.status).toBe(200)
    const body = await res.json() as { deletedDocs: number }
    expect(body.deletedDocs).toBe(2)
    expect(await countDocs(ws.workspaceId)).toBe(0)
  })

  it('editor cannot delete workspace (403)', async () => {
    const admin = await createUser()
    const editor = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    const client = await loggedInClient(editor.id)
    const res = await client.delete(`/api/workspaces/${ws.workspaceId}`)
    expect(res.status).toBe(403)
    expect(await workspaceExists(ws.workspaceId)).toBe(true)
  })

  it('viewer cannot delete workspace (403)', async () => {
    const admin = await createUser()
    const viewer = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
    const client = await loggedInClient(viewer.id)
    const res = await client.delete(`/api/workspaces/${ws.workspaceId}`)
    expect(res.status).toBe(403)
  })

  it('non-member is 404 (not even the workspace should exist to them)', async () => {
    const admin = await createUser()
    const stranger = await createUser()
    const ws = await createWorkspace(admin.id)
    const client = await loggedInClient(stranger.id)
    const res = await client.delete(`/api/workspaces/${ws.workspaceId}`)
    expect(res.status).toBe(404)
  })
})

describe('POST /api/workspaces/:wsId/members (invite)', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('admin can invite an existing user by email with default editor role', async () => {
    const admin = await createUser()
    const invitee = await createUser({ email: 'invite@test.local' })
    const ws = await createWorkspace(admin.id)
    const client = await loggedInClient(admin.id)
    const res = await client.post(`/api/workspaces/${ws.workspaceId}/members`, {
      email: 'invite@test.local'
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { userId: number, role: string }
    expect(body.userId).toBe(invitee.id)
    expect(body.role).toBe('editor')
  })

  it('admin can invite with an explicit role', async () => {
    const admin = await createUser()
    const invitee = await createUser({ email: 'viewer@test.local' })
    const ws = await createWorkspace(admin.id)
    const client = await loggedInClient(admin.id)
    const res = await client.post(`/api/workspaces/${ws.workspaceId}/members`, {
      email: 'viewer@test.local',
      role: 'viewer'
    })
    expect(res.status).toBe(200)
    expect((await res.json() as { role: string }).role).toBe('viewer')
  })

  it('email match is case-insensitive', async () => {
    const admin = await createUser()
    await createUser({ email: 'Alice@Test.Local' })
    const ws = await createWorkspace(admin.id)
    const client = await loggedInClient(admin.id)
    const res = await client.post(`/api/workspaces/${ws.workspaceId}/members`, {
      email: 'alice@test.local'
    })
    expect(res.status).toBe(200)
  })

  it('rejects invalid role (400)', async () => {
    const admin = await createUser()
    await createUser({ email: 'x@test.local' })
    const ws = await createWorkspace(admin.id)
    const client = await loggedInClient(admin.id)
    const res = await client.post(`/api/workspaces/${ws.workspaceId}/members`, {
      email: 'x@test.local',
      role: 'godmode'
    })
    expect(res.status).toBe(400)
  })

  it('rejects malformed email (400)', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const client = await loggedInClient(admin.id)
    const res = await client.post(`/api/workspaces/${ws.workspaceId}/members`, {
      email: 'not-an-email'
    })
    expect(res.status).toBe(400)
  })

  it('returns 404 for unknown email (never leaks user existence)', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const client = await loggedInClient(admin.id)
    const res = await client.post(`/api/workspaces/${ws.workspaceId}/members`, {
      email: 'noone@nowhere.test'
    })
    expect(res.status).toBe(404)
  })

  it('returns 409 when user is already a member', async () => {
    const admin = await createUser()
    const member = await createUser({ email: 'member@test.local' })
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, member.id, 'editor')
    const client = await loggedInClient(admin.id)
    const res = await client.post(`/api/workspaces/${ws.workspaceId}/members`, {
      email: 'member@test.local'
    })
    expect(res.status).toBe(409)
  })

  it('editor cannot invite (403, admin-only)', async () => {
    const admin = await createUser()
    const editor = await createUser()
    await createUser({ email: 'target@test.local' })
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    const client = await loggedInClient(editor.id)
    const res = await client.post(`/api/workspaces/${ws.workspaceId}/members`, {
      email: 'target@test.local'
    })
    expect(res.status).toBe(403)
  })

  it('non-member is 404', async () => {
    const admin = await createUser()
    const stranger = await createUser()
    await createUser({ email: 'target@test.local' })
    const ws = await createWorkspace(admin.id)
    const client = await loggedInClient(stranger.id)
    const res = await client.post(`/api/workspaces/${ws.workspaceId}/members`, {
      email: 'target@test.local'
    })
    expect(res.status).toBe(404)
  })
})
