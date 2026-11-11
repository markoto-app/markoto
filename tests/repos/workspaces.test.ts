import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import {
  getWorkspace,
  createWorkspace,
  updateWorkspace,
  deleteWorkspaceRow,
  listWorkspacesForUser
} from '../../server/repos/workspaces'
import { NotFoundError } from '../../server/repos/errors'
import {
  createUser,
  createDoc as seedDoc,
  createWorkspace as seedWorkspace,
  setMemberRole
} from '../integration/setup/fixtures'

async function memberCount(workspaceId: string): Promise<number> {
  const db = testDb()
  const r = await db.query<{ c: string }>(
    'SELECT COUNT(*) AS c FROM workspace_members WHERE workspace_id = $1',
    [workspaceId]
  )
  return Number(r.rows[0]?.c ?? 0)
}

async function workspaceCount(): Promise<number> {
  const db = testDb()
  const r = await db.query<{ c: string }>('SELECT COUNT(*) AS c FROM workspaces')
  return Number(r.rows[0]?.c ?? 0)
}

describe('createWorkspace', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('inserts the workspace row AND the creator-admin member row', async () => {
    const user = await createUser()
    await createWorkspace({ workspaceId: 'ws-1', ownerId: user.id, name: 'Team' })
    const ws = await getWorkspace('ws-1')
    expect(ws).not.toBeNull()
    expect(ws!.ownerId).toBe(user.id)
    expect(await memberCount('ws-1')).toBe(1)
  })

  it('creator\'s membership row carries role=admin', async () => {
    const user = await createUser()
    await createWorkspace({ workspaceId: 'ws-a', ownerId: user.id, name: 'X' })
    const db = testDb()
    const r = await db.query<{ role: string }>(
      'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      ['ws-a', user.id]
    )
    expect(r.rows[0]?.role).toBe('admin')
  })

  it('atomic: forced-failure on the member insert rolls back the workspace', async () => {
    // The workspace and its first member are inserted in one transaction; two separate INSERTs could leave a
    // workspace with no members (a zero-admin workspace).
    //
    // Force the member insert to fail by pointing ownerId at a user_id that doesn't exist (workspace_members.user_id
    // has an FK to users(id)). The transaction should roll back the workspaces INSERT that landed earlier in the
    // same tx.
    await expect(
      createWorkspace({ workspaceId: 'ws-bad', ownerId: 99999, name: 'Ghost' })
    ).rejects.toThrow()
    expect(await getWorkspace('ws-bad')).toBeNull()
    expect(await workspaceCount()).toBe(0)
  })
})

describe('updateWorkspace', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('applies a name update', async () => {
    const user = await createUser()
    const ws = await seedWorkspace(user.id)
    await updateWorkspace(ws.workspaceId, { name: 'Renamed' })
    expect((await getWorkspace(ws.workspaceId))!.name).toBe('Renamed')
  })

  it('applies a description update (including null)', async () => {
    const user = await createUser()
    const ws = await seedWorkspace(user.id)
    await updateWorkspace(ws.workspaceId, { description: 'hi' })
    expect((await getWorkspace(ws.workspaceId))!.description).toBe('hi')
    await updateWorkspace(ws.workspaceId, { description: null })
    expect((await getWorkspace(ws.workspaceId))!.description).toBeNull()
  })

  it('is a no-op when update object is empty', async () => {
    const user = await createUser()
    const ws = await seedWorkspace(user.id)
    const before = (await getWorkspace(ws.workspaceId))!
    await updateWorkspace(ws.workspaceId, {})
    const after = (await getWorkspace(ws.workspaceId))!
    expect(after.name).toBe(before.name)
  })

  it('throws NotFoundError for a nonexistent workspaceId', async () => {
    await expect(updateWorkspace('missing', { name: 'x' }))
      .rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('deleteWorkspaceRow', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('removes the workspace row', async () => {
    const user = await createUser()
    const ws = await seedWorkspace(user.id)
    await deleteWorkspaceRow(ws.workspaceId)
    expect(await getWorkspace(ws.workspaceId)).toBeNull()
  })

  it('cascades workspace_members via the FK', async () => {
    const user = await createUser()
    const other = await createUser()
    const ws = await seedWorkspace(user.id)
    await setMemberRole(ws.workspaceId, other.id, 'editor')
    expect(await memberCount(ws.workspaceId)).toBe(2)
    await deleteWorkspaceRow(ws.workspaceId)
    expect(await memberCount(ws.workspaceId)).toBe(0)
  })

  it('detaches documents (ownerId set-null FK) but keeps the rows', async () => {
    // The FK on documents.workspace_id is `set null` so docs outlive
    // their workspace by design — the workspace-delete endpoint does
    // the per-doc cascade separately. This pins the raw SQL behavior.
    const user = await createUser()
    const ws = await seedWorkspace(user.id)
    const doc = await seedDoc({ ownerId: user.id, workspaceId: ws.workspaceId })
    await deleteWorkspaceRow(ws.workspaceId)
    const db = testDb()
    const r = await db.query<{ workspace_id: string | null }>(
      'SELECT workspace_id FROM documents WHERE doc_id = $1', [doc.docId]
    )
    expect(r.rows[0]?.workspace_id).toBeNull()
  })
})

describe('listWorkspacesForUser', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns only workspaces the user is a member of, with their role', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const wsA = await seedWorkspace(alice.id)
    const wsB = await seedWorkspace(bob.id)
    await setMemberRole(wsA.workspaceId, bob.id, 'editor')
    const rows = await listWorkspacesForUser(bob.id)
    const byId = new Map(rows.map(r => [r.workspaceId, r]))
    expect(byId.get(wsA.workspaceId)?.role).toBe('editor')
    expect(byId.get(wsB.workspaceId)?.role).toBe('admin')
    expect(rows.length).toBe(2)
  })

  it('aggregates docCount per workspace', async () => {
    const u = await createUser()
    const ws = await seedWorkspace(u.id)
    await seedDoc({ ownerId: u.id, workspaceId: ws.workspaceId })
    await seedDoc({ ownerId: u.id, workspaceId: ws.workspaceId })
    const rows = await listWorkspacesForUser(u.id)
    expect(rows[0].docCount).toBe(2)
  })

  it('empty workspaces still appear with docCount=0 and lastActive=null', async () => {
    const u = await createUser()
    await seedWorkspace(u.id)
    const rows = await listWorkspacesForUser(u.id)
    expect(rows.length).toBe(1)
    expect(rows[0].docCount).toBe(0)
    expect(rows[0].lastActive).toBeNull()
  })
})

describe('createWorkspace — race', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('two concurrent creates with different ids both land cleanly', async () => {
    // Sanity for the base case — no shared state, so both should
    // succeed independently. If the tx were wrongly using a module-level
    // lock, this would serialize-and-slow-down; we just verify both
    // workspaces exist afterwards.
    const user = await createUser()
    await Promise.all([
      createWorkspace({ workspaceId: 'race-a', ownerId: user.id, name: 'A' }),
      createWorkspace({ workspaceId: 'race-b', ownerId: user.id, name: 'B' })
    ])
    expect(await getWorkspace('race-a')).not.toBeNull()
    expect(await getWorkspace('race-b')).not.toBeNull()
    expect(await memberCount('race-a')).toBe(1)
    expect(await memberCount('race-b')).toBe(1)
  })
})
