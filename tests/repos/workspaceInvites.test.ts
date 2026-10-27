import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import { createUser, createWorkspace } from '../integration/setup/fixtures'
import {
  acceptWorkspaceInvite,
  countOpenWorkspaceInvites,
  deleteExpiredWorkspaceInvites,
  listInvitesForEmail,
  upsertWorkspaceInvite
} from '../../server/repos/workspaceInvites'
import { runWorkspaceInviteSweep } from '../../server/utils/workspaceInviteSweep'

const DAY = 24 * 60 * 60 * 1000

async function memberRole(wsId: string, userId: number): Promise<string | null> {
  const r = await testDb().query<{ role: string }>(
    'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
    [wsId, userId]
  )
  return r.rows[0]?.role ?? null
}

describe('workspace_invites repo', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('upsert keeps one open invite per (workspace, email) and rotates the token', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const first = await upsertWorkspaceInvite({
      workspaceId: ws.workspaceId, email: 'a@test.local', role: 'viewer', invitedByUserId: admin.id,
      tokenHash: 'hash-1', expiresAt: new Date(Date.now() + DAY)
    })
    const second = await upsertWorkspaceInvite({
      workspaceId: ws.workspaceId, email: 'a@test.local', role: 'editor', invitedByUserId: admin.id,
      tokenHash: 'hash-2', expiresAt: new Date(Date.now() + 2 * DAY)
    })
    expect(second).toBe(first)
    const rows = await testDb().query<{ role: string, token_hash: string }>('SELECT role, token_hash FROM workspace_invites')
    expect(rows.rows).toEqual([{ role: 'editor', token_hash: 'hash-2' }])
  })

  it('counts only unexpired invites, optionally excluding one address', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const now = new Date()
    await upsertWorkspaceInvite({ workspaceId: ws.workspaceId, email: 'a@test.local', role: 'editor', invitedByUserId: admin.id, tokenHash: null, expiresAt: new Date(now.getTime() + DAY) })
    await upsertWorkspaceInvite({ workspaceId: ws.workspaceId, email: 'b@test.local', role: 'editor', invitedByUserId: admin.id, tokenHash: null, expiresAt: new Date(now.getTime() - DAY) })
    expect(await countOpenWorkspaceInvites(ws.workspaceId, now)).toBe(1)
    expect(await countOpenWorkspaceInvites(ws.workspaceId, now, 'a@test.local')).toBe(0)
  })

  it('two concurrent accepts of the same invite produce one membership and one success', async () => {
    const admin = await createUser()
    const invitee = await createUser({ email: 'race@test.local' })
    const ws = await createWorkspace(admin.id)
    const inviteId = await upsertWorkspaceInvite({
      workspaceId: ws.workspaceId, email: 'race@test.local', role: 'editor', invitedByUserId: admin.id,
      tokenHash: null, expiresAt: new Date(Date.now() + DAY)
    })
    const selector = { kind: 'id' as const, inviteId, email: 'race@test.local' }
    const results = await Promise.all([
      acceptWorkspaceInvite(selector, invitee.id, new Date()),
      acceptWorkspaceInvite(selector, invitee.id, new Date())
    ])
    expect(results.filter(r => r !== null)).toHaveLength(1)
    expect(await memberRole(ws.workspaceId, invitee.id)).toBe('editor')
  })

  it('the sweeper deletes expired invites only', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const now = new Date()
    await upsertWorkspaceInvite({ workspaceId: ws.workspaceId, email: 'old@test.local', role: 'editor', invitedByUserId: admin.id, tokenHash: null, expiresAt: new Date(now.getTime() - 1000) })
    await upsertWorkspaceInvite({ workspaceId: ws.workspaceId, email: 'new@test.local', role: 'editor', invitedByUserId: admin.id, tokenHash: null, expiresAt: new Date(now.getTime() + DAY) })
    expect(await runWorkspaceInviteSweep(now)).toEqual({ deletedExpired: 1 })
    expect(await deleteExpiredWorkspaceInvites(now)).toBe(0)
    expect((await listInvitesForEmail('new@test.local', now)).map(i => i.workspaceId)).toEqual([ws.workspaceId])
  })

  it('invites cascade with the workspace', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    await upsertWorkspaceInvite({ workspaceId: ws.workspaceId, email: 'a@test.local', role: 'editor', invitedByUserId: admin.id, tokenHash: null, expiresAt: new Date(Date.now() + DAY) })
    await testDb().query('DELETE FROM workspace_members WHERE workspace_id = $1', [ws.workspaceId])
    await testDb().query('DELETE FROM workspaces WHERE workspace_id = $1', [ws.workspaceId])
    const rows = await testDb().query('SELECT 1 FROM workspace_invites')
    expect(rows.rowCount).toBe(0)
  })
})
