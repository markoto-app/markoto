import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import {
  createDoc,
  createUser,
  createWorkspace,
  setMemberRole
} from '../setup/fixtures'
import { clearRecentKicks, waitForKick, fetchRecentKicks } from '../setup/syncProbe'

// PATCH / DELETE /api/workspaces/:wsId/members/:userId
//
// Two high-risk invariants live here:
//   1. "≥1 admin": demoting or removing the last admin must 409.
//   2. JWT revocation on membership change: after the mutation, the app MUST dispatch a kick-user to the
//      sync-server with the target userId and every workspace doc. Without it, changes silently leave stale
//      JWTs valid for up to 2 hours.
//
// The kick-side assertion uses `waitForKick` against the real sync-test container's TEST_MODE-only
// `/internal/_test/recent-kicks` ring buffer (see `tests/integration/setup/syncProbe.ts`), so the kick goes
// through the SAME code path prod uses (Nuxt → sync-test container → kickUser handler). The dispatch SHAPE
// (URL, headers, body) is also pinned at the unit tier in `tests/unit/sync/syncNotify.test.ts`: defence in
// depth against the dispatch site being silently removed.

async function roleOf(workspaceId: string, userId: number): Promise<string | null> {
  const db = testDb()
  const r = await db.query<{ role: string }>(
    'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
    [workspaceId, userId]
  )
  return r.rows[0]?.role ?? null
}

describe('PATCH /api/workspaces/:wsId/members/:userId', () => {
  beforeEach(async () => {
    await resetDb()
    await clearRecentKicks()
  })

  it('admin can promote editor to admin', async () => {
    const admin = await createUser()
    const editor = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    const client = await loggedInClient(admin.id)
    const res = await client.patch(
      `/api/workspaces/${ws.workspaceId}/members/${editor.id}`,
      { role: 'admin' }
    )
    expect(res.status).toBe(200)
    expect(await roleOf(ws.workspaceId, editor.id)).toBe('admin')
  })

  it('non-admin cannot change roles (403)', async () => {
    const admin = await createUser()
    const editor = await createUser()
    const other = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    await setMemberRole(ws.workspaceId, other.id, 'viewer')
    const client = await loggedInClient(editor.id)
    const res = await client.patch(
      `/api/workspaces/${ws.workspaceId}/members/${other.id}`,
      { role: 'admin' }
    )
    expect(res.status).toBe(403)
  })

  it('rejects invalid role with 400', async () => {
    const admin = await createUser()
    const editor = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    const client = await loggedInClient(admin.id)
    const res = await client.patch(
      `/api/workspaces/${ws.workspaceId}/members/${editor.id}`,
      { role: 'superadmin' }
    )
    expect(res.status).toBe(400)
  })

  it('refuses to demote the last admin (last-admin invariant, 409)', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const client = await loggedInClient(admin.id)
    const res = await client.patch(
      `/api/workspaces/${ws.workspaceId}/members/${admin.id}`,
      { role: 'editor' }
    )
    expect(res.status).toBe(409)
    expect(await roleOf(ws.workspaceId, admin.id)).toBe('admin')
  })

  it('allows demoting an admin when another admin exists', async () => {
    const a1 = await createUser()
    const a2 = await createUser()
    const ws = await createWorkspace(a1.id)
    await setMemberRole(ws.workspaceId, a2.id, 'admin')
    const client = await loggedInClient(a1.id)
    const res = await client.patch(
      `/api/workspaces/${ws.workspaceId}/members/${a2.id}`,
      { role: 'editor' }
    )
    expect(res.status).toBe(200)
    expect(await roleOf(ws.workspaceId, a2.id)).toBe('editor')
  })

  it('no-ops when the role is unchanged (200, noop: true)', async () => {
    const admin = await createUser()
    const editor = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    const client = await loggedInClient(admin.id)
    const res = await client.patch(
      `/api/workspaces/${ws.workspaceId}/members/${editor.id}`,
      { role: 'editor' }
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { noop?: boolean }
    expect(body.noop).toBe(true)
    // No kick dispatched on no-op, saves a useless round-trip.
    // Brief settle so a buggy dispatch would have time to land.
    await new Promise(r => setTimeout(r, 200))
    const kicks = await fetchRecentKicks()
    expect(kicks).toHaveLength(0)
  })

  it('dispatches kick-user with the target userId and every workspace doc', async () => {
    const admin = await createUser()
    const editor = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    const doc1 = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId, accessMode: 'private' })
    const doc2 = await createDoc({ ownerId: editor.id, workspaceId: ws.workspaceId, accessMode: 'private' })
    const client = await loggedInClient(admin.id)
    const res = await client.patch(
      `/api/workspaces/${ws.workspaceId}/members/${editor.id}`,
      { role: 'viewer' }
    )
    expect(res.status).toBe(200)
    const kick = await waitForKick(k => k.userId === String(editor.id))
    expect(new Set(kick.docIds)).toEqual(new Set([doc1.docId, doc2.docId]))
  })

  it('dispatches kick even when role LOOSENS (viewer → editor)', async () => {
    // Over-kicking is intentional (see syncNotify.ts rationale); do not optimise it to kick only on tightening.
    const admin = await createUser()
    const viewer = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
    await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId, accessMode: 'private' })
    const client = await loggedInClient(admin.id)
    await client.patch(
      `/api/workspaces/${ws.workspaceId}/members/${viewer.id}`,
      { role: 'editor' }
    )
    const kick = await waitForKick(k => k.userId === String(viewer.id))
    expect(kick.userId).toBe(String(viewer.id))
  })
})

describe('DELETE /api/workspaces/:wsId/members/:userId', () => {
  beforeEach(async () => {
    await resetDb()
    await clearRecentKicks()
  })

  it('admin can remove another member', async () => {
    const admin = await createUser()
    const editor = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    const client = await loggedInClient(admin.id)
    const res = await client.delete(`/api/workspaces/${ws.workspaceId}/members/${editor.id}`)
    expect(res.status).toBe(200)
    expect(await roleOf(ws.workspaceId, editor.id)).toBeNull()
  })

  it('editor can leave (self-remove)', async () => {
    const admin = await createUser()
    const editor = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    const client = await loggedInClient(editor.id)
    const res = await client.delete(`/api/workspaces/${ws.workspaceId}/members/${editor.id}`)
    expect(res.status).toBe(200)
    expect(await roleOf(ws.workspaceId, editor.id)).toBeNull()
  })

  it('editor cannot remove someone else (403)', async () => {
    const admin = await createUser()
    const a = await createUser()
    const b = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, a.id, 'editor')
    await setMemberRole(ws.workspaceId, b.id, 'editor')
    const client = await loggedInClient(a.id)
    const res = await client.delete(`/api/workspaces/${ws.workspaceId}/members/${b.id}`)
    expect(res.status).toBe(403)
    expect(await roleOf(ws.workspaceId, b.id)).toBe('editor')
  })

  it('refuses to remove the last admin (409)', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const client = await loggedInClient(admin.id)
    const res = await client.delete(`/api/workspaces/${ws.workspaceId}/members/${admin.id}`)
    expect(res.status).toBe(409)
    expect(await roleOf(ws.workspaceId, admin.id)).toBe('admin')
  })

  it('allows admin self-leave when another admin exists', async () => {
    const a1 = await createUser()
    const a2 = await createUser()
    const ws = await createWorkspace(a1.id)
    await setMemberRole(ws.workspaceId, a2.id, 'admin')
    const client = await loggedInClient(a1.id)
    const res = await client.delete(`/api/workspaces/${ws.workspaceId}/members/${a1.id}`)
    expect(res.status).toBe(200)
    expect(await roleOf(ws.workspaceId, a1.id)).toBeNull()
  })

  it('dispatches kick-user on successful removal (JWT revocation regression guard)', async () => {
    const admin = await createUser()
    const editor = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    const doc = await createDoc({
      ownerId: admin.id,
      workspaceId: ws.workspaceId,
      accessMode: 'private'
    })
    const client = await loggedInClient(admin.id)
    const res = await client.delete(`/api/workspaces/${ws.workspaceId}/members/${editor.id}`)
    expect(res.status).toBe(200)
    expect(await roleOf(ws.workspaceId, editor.id)).toBeNull()
    const kick = await waitForKick(k => k.userId === String(editor.id))
    expect(kick.docIds).toContain(doc.docId)
  })

  it('refuses invalid userId (400)', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const client = await loggedInClient(admin.id)
    const res = await client.delete(`/api/workspaces/${ws.workspaceId}/members/notanumber`)
    expect(res.status).toBe(400)
  })

  it('returns 404 when target is not a member', async () => {
    const admin = await createUser()
    const stranger = await createUser()
    const ws = await createWorkspace(admin.id)
    const client = await loggedInClient(admin.id)
    const res = await client.delete(`/api/workspaces/${ws.workspaceId}/members/${stranger.id}`)
    expect(res.status).toBe(404)
  })

  it('anonymous caller is refused by middleware (401)', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const res = await anonClient().delete(`/api/workspaces/${ws.workspaceId}/members/${admin.id}`)
    expect(res.status).toBe(401)
  })
})
