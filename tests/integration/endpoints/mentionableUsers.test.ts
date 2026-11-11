import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import {
  createDoc,
  createUser,
  createWorkspace,
  setMemberRole
} from '../setup/fixtures'

// GET /api/docs/:docId/mentionable-users — typeahead source for the
// comments composer.
//
// Privacy posture (no user enumeration): only workspace docs return a real list,
// and only to members of that workspace. Standalone docs and non-member
// viewers get an empty list. Anonymous gets 401 (auth middleware).

describe('GET /api/docs/:docId/mentionable-users', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('rejects anonymous (401)', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const doc = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId })
    const res = await anonClient().get(`/api/docs/${doc.docId}/mentionable-users`)
    expect(res.status).toBe(401)
  })

  it('returns 404 for a nonexistent doc', async () => {
    const u = await createUser()
    const c = await loggedInClient(u.id)
    const res = await c.get('/api/docs/does-not-exist/mentionable-users')
    expect(res.status).toBe(404)
  })

  it('returns the workspace roster for a workspace member', async () => {
    const admin = await createUser({ name: 'Alice' })
    const editor = await createUser({ name: 'Bob' })
    const viewer = await createUser({ name: 'Carol' })
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
    const doc = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId })

    const c = await loggedInClient(admin.id)
    const res = await c.get(`/api/docs/${doc.docId}/mentionable-users`)
    expect(res.status).toBe(200)
    const body = await res.json() as { users: Array<{ id: number, name: string }> }
    const ids = body.users.map(u => u.id).sort()
    expect(ids).toEqual([admin.id, editor.id, viewer.id].sort())
  })

  it('returns empty list when viewer is logged in but not a member of the workspace', async () => {
    const admin = await createUser()
    const outsider = await createUser()
    const ws = await createWorkspace(admin.id)
    const doc = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId, accessMode: 'open-view' })

    const c = await loggedInClient(outsider.id)
    const res = await c.get(`/api/docs/${doc.docId}/mentionable-users`)
    expect(res.status).toBe(200)
    const body = await res.json() as { users: unknown[] }
    expect(body.users).toEqual([])
  })

  it('returns empty list for a standalone (non-workspace) doc', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    expect(doc.workspaceId).toBeNull()

    const c = await loggedInClient(owner.id)
    const res = await c.get(`/api/docs/${doc.docId}/mentionable-users`)
    expect(res.status).toBe(200)
    const body = await res.json() as { users: unknown[] }
    expect(body.users).toEqual([])
  })
})
