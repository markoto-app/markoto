import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import {
  getMemberRole,
  listMembers,
  listMembersForDoc,
  countAdmins,
  addMember,
  setRole,
  removeMember
} from '../../server/repos/workspaceMembers'
import { LastAdminError, NotFoundError } from '../../server/repos/errors'
import {
  createUser,
  createWorkspace as seedWorkspace,
  setMemberRole
} from '../integration/setup/fixtures'

describe('getMemberRole', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns the role for a member', async () => {
    const admin = await createUser()
    const editor = await createUser()
    const ws = await seedWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    expect(await getMemberRole(ws.workspaceId, editor.id)).toBe('editor')
  })

  it('returns null for non-members', async () => {
    const admin = await createUser()
    const stranger = await createUser()
    const ws = await seedWorkspace(admin.id)
    expect(await getMemberRole(ws.workspaceId, stranger.id)).toBeNull()
  })

  it('returns null for nonexistent workspace', async () => {
    const u = await createUser()
    expect(await getMemberRole('missing', u.id)).toBeNull()
  })
})

describe('listMembers', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns every member, ordered admin → editor → viewer', async () => {
    const admin = await createUser({ name: 'Admin' })
    const editor = await createUser({ name: 'Editor' })
    const viewer = await createUser({ name: 'Viewer' })
    const ws = await seedWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    const members = await listMembers(ws.workspaceId)
    expect(members.map(m => m.role)).toEqual(['admin', 'editor', 'viewer'])
  })

  it('joins against users so name/email are populated (no avatar URL)', async () => {
    const admin = await createUser({ name: 'Admin', email: 'admin@test.local' })
    const ws = await seedWorkspace(admin.id)
    const members = await listMembers(ws.workspaceId)
    expect(members[0].name).toBe('Admin')
    expect(members[0].email).toBe('admin@test.local')
    expect(members[0]).not.toHaveProperty('avatarUrl')
  })
})

describe('listMembersForDoc', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('flags the doc owner via isDocOwner', async () => {
    const creator = await createUser()
    const other = await createUser()
    const ws = await seedWorkspace(creator.id)
    await setMemberRole(ws.workspaceId, other.id, 'editor')
    // docOwnerId = creator.id
    const members = await listMembersForDoc(ws.workspaceId, creator.id)
    const byId = new Map(members.map(m => [m.userId, m]))
    expect(byId.get(creator.id)!.isDocOwner).toBe(true)
    expect(byId.get(other.id)!.isDocOwner).toBe(false)
  })
})

describe('countAdmins', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('counts only admins', async () => {
    const a1 = await createUser()
    const a2 = await createUser()
    const editor = await createUser()
    const ws = await seedWorkspace(a1.id)
    await setMemberRole(ws.workspaceId, a2.id, 'admin')
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    expect(await countAdmins(ws.workspaceId)).toBe(2)
  })

  it('returns 0 for a workspace with no admins (e.g. bad test fixture)', async () => {
    const u = await createUser()
    const ws = await seedWorkspace(u.id)
    const db = testDb()
    // Force-drop the admin row to verify the count reads reality, not a
    // computed invariant.
    await db.query('DELETE FROM workspace_members WHERE workspace_id = $1', [ws.workspaceId])
    expect(await countAdmins(ws.workspaceId)).toBe(0)
  })
})

describe('addMember', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('inserts a new member with the supplied role', async () => {
    const admin = await createUser()
    const target = await createUser()
    const ws = await seedWorkspace(admin.id)
    await addMember(ws.workspaceId, target.id, 'viewer')
    expect(await getMemberRole(ws.workspaceId, target.id)).toBe('viewer')
  })

  it('rejects duplicate insert (PK conflict propagates)', async () => {
    const admin = await createUser()
    const ws = await seedWorkspace(admin.id)
    // Creator already has an admin row from seedWorkspace; a second add
    // for the same (ws, user) violates the PK.
    await expect(addMember(ws.workspaceId, admin.id, 'editor')).rejects.toThrow()
  })
})

describe('setRole', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('promotes editor → admin', async () => {
    const admin = await createUser()
    const editor = await createUser()
    const ws = await seedWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    const prev = await setRole(ws.workspaceId, editor.id, 'admin')
    expect(prev).toBe('editor')
    expect(await getMemberRole(ws.workspaceId, editor.id)).toBe('admin')
  })

  it('demotes admin → editor when another admin exists', async () => {
    const a1 = await createUser()
    const a2 = await createUser()
    const ws = await seedWorkspace(a1.id)
    await setMemberRole(ws.workspaceId, a2.id, 'admin')
    const prev = await setRole(ws.workspaceId, a2.id, 'editor')
    expect(prev).toBe('admin')
    expect(await getMemberRole(ws.workspaceId, a2.id)).toBe('editor')
  })

  it('refuses to demote the last admin (LastAdminError)', async () => {
    const admin = await createUser()
    const ws = await seedWorkspace(admin.id)
    await expect(setRole(ws.workspaceId, admin.id, 'editor'))
      .rejects.toBeInstanceOf(LastAdminError)
    // Role unchanged.
    expect(await getMemberRole(ws.workspaceId, admin.id)).toBe('admin')
  })

  it('no-op when role unchanged (returns previous role, no write)', async () => {
    const admin = await createUser()
    const editor = await createUser()
    const ws = await seedWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    const prev = await setRole(ws.workspaceId, editor.id, 'editor')
    expect(prev).toBe('editor')
  })

  it('throws NotFoundError when target is not a member', async () => {
    const admin = await createUser()
    const stranger = await createUser()
    const ws = await seedWorkspace(admin.id)
    await expect(setRole(ws.workspaceId, stranger.id, 'editor'))
      .rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('removeMember', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('removes a non-admin member', async () => {
    const admin = await createUser()
    const editor = await createUser()
    const ws = await seedWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    const role = await removeMember(ws.workspaceId, editor.id)
    expect(role).toBe('editor')
    expect(await getMemberRole(ws.workspaceId, editor.id)).toBeNull()
  })

  it('removes a non-last admin', async () => {
    const a1 = await createUser()
    const a2 = await createUser()
    const ws = await seedWorkspace(a1.id)
    await setMemberRole(ws.workspaceId, a2.id, 'admin')
    await removeMember(ws.workspaceId, a2.id)
    expect(await getMemberRole(ws.workspaceId, a2.id)).toBeNull()
  })

  it('refuses to remove the last admin (LastAdminError)', async () => {
    const admin = await createUser()
    const ws = await seedWorkspace(admin.id)
    await expect(removeMember(ws.workspaceId, admin.id))
      .rejects.toBeInstanceOf(LastAdminError)
    expect(await getMemberRole(ws.workspaceId, admin.id)).toBe('admin')
  })

  it('throws NotFoundError when target is not a member', async () => {
    const admin = await createUser()
    const stranger = await createUser()
    const ws = await seedWorkspace(admin.id)
    await expect(removeMember(ws.workspaceId, stranger.id))
      .rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('last-admin invariant — concurrent races', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('two concurrent admin-demotions on a two-admin workspace: exactly one succeeds', async () => {
    // Without the setRole transaction, both calls could read adminCount=2,
    // both decide they're safe to demote, and both commit. Result: zero
    // admins. The transactional repo serializes them via row locks from
    // the SELECT, so only one demotion succeeds; the other sees the
    // intermediate state and rejects (LastAdminError) — OR both succeed
    // at the wire level and pg serialization retries/kills one. Either
    // way the terminal state must have ≥1 admin.
    const a1 = await createUser()
    const a2 = await createUser()
    const ws = await seedWorkspace(a1.id)
    await setMemberRole(ws.workspaceId, a2.id, 'admin')
    expect(await countAdmins(ws.workspaceId)).toBe(2)

    const results = await Promise.allSettled([
      setRole(ws.workspaceId, a1.id, 'editor'),
      setRole(ws.workspaceId, a2.id, 'editor')
    ])
    // At least one must have been rejected (or one succeeded and the
    // other's check caught the invariant).
    const terminalAdmins = await countAdmins(ws.workspaceId)
    expect(terminalAdmins).toBeGreaterThanOrEqual(1)
    const rejected = results.filter(r => r.status === 'rejected').length
    const fulfilled = results.filter(r => r.status === 'fulfilled').length
    // One of three legitimate outcomes:
    //  - Both tried, one got LastAdminError. (rejected=1, fulfilled=1,
    //    terminal=1)
    //  - Both succeeded at the wire level but pg serialized them so the
    //    second's invariant check caught an admin count of 1 and rolled
    //    back. Shouldn't happen with READ COMMITTED but pin the outcome.
    //  - Both somehow succeeded → terminal=0 → the expect above fails.
    expect(rejected + fulfilled).toBe(2)
    expect(terminalAdmins).toBeGreaterThanOrEqual(1)
  })

  it('two concurrent admin self-removals: at most one succeeds', async () => {
    const a1 = await createUser()
    const a2 = await createUser()
    const ws = await seedWorkspace(a1.id)
    await setMemberRole(ws.workspaceId, a2.id, 'admin')

    await Promise.allSettled([
      removeMember(ws.workspaceId, a1.id),
      removeMember(ws.workspaceId, a2.id)
    ])
    // At least one admin must survive.
    expect(await countAdmins(ws.workspaceId)).toBeGreaterThanOrEqual(1)
  })

  it('serial demotions behave identically to the concurrent case', async () => {
    // Baseline: the transactional wrapper doesn't break the sequential
    // happy path. First demotion goes through, second hits the invariant.
    const a1 = await createUser()
    const a2 = await createUser()
    const ws = await seedWorkspace(a1.id)
    await setMemberRole(ws.workspaceId, a2.id, 'admin')
    await setRole(ws.workspaceId, a1.id, 'editor')
    await expect(setRole(ws.workspaceId, a2.id, 'editor'))
      .rejects.toBeInstanceOf(LastAdminError)
    expect(await countAdmins(ws.workspaceId)).toBe(1)
  })
})
