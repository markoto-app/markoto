import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import {
  createDoc,
  createUser,
  createWorkspace,
  setMemberRole
} from '../setup/fixtures'

// PATCH /api/docs/:docId/workspace — moves a doc into, between, or out
// of a workspace. Authz band:
//   - Source-side: canManageDoc (owner or source workspace admin)
//   - Target-side: admin or editor of the target workspace (if any)
//
// The tests below pin each cell in that matrix plus the no-op and
// 400-validation edge cases.

async function readWorkspaceId(docId: string): Promise<string | null> {
  const db = testDb()
  const r = await db.query<{ workspace_id: string | null }>(
    'SELECT workspace_id FROM documents WHERE doc_id = $1',
    [docId]
  )
  return r.rows[0]?.workspace_id ?? null
}

describe('PATCH /api/docs/:docId/workspace', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns 401 for anonymous callers (middleware gate)', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
    const res = await anonClient().patch(`/api/docs/${doc.docId}/workspace`, { workspaceId: null })
    expect(res.status).toBe(401)
  })

  it('returns 404 for a nonexistent doc', async () => {
    const user = await createUser()
    const client = await loggedInClient(user.id)
    const res = await client.patch('/api/docs/ghost/workspace', { workspaceId: null })
    expect(res.status).toBe(404)
  })

  describe('body validation (400s)', () => {
    it('rejects a missing workspaceId field', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id })
      const client = await loggedInClient(owner.id)
      const res = await client.patch(`/api/docs/${doc.docId}/workspace`, {})
      expect(res.status).toBe(400)
    })

    it('rejects an empty-string workspaceId (would silently noop with a cast)', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id })
      const client = await loggedInClient(owner.id)
      const res = await client.patch(`/api/docs/${doc.docId}/workspace`, { workspaceId: '' })
      expect(res.status).toBe(400)
    })

    it('rejects a non-string, non-null workspaceId', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id })
      const client = await loggedInClient(owner.id)
      const res = await client.patch(`/api/docs/${doc.docId}/workspace`, { workspaceId: 42 })
      expect(res.status).toBe(400)
    })
  })

  describe('source-side authz', () => {
    it('doc owner can move their standalone doc into a workspace', async () => {
      const owner = await createUser()
      const ws = await createWorkspace(owner.id)
      const doc = await createDoc({ ownerId: owner.id })
      const client = await loggedInClient(owner.id)
      const res = await client.patch(`/api/docs/${doc.docId}/workspace`, {
        workspaceId: ws.workspaceId
      })
      expect(res.status).toBe(200)
      expect(await readWorkspaceId(doc.docId)).toBe(ws.workspaceId)
    })

    it('doc owner can detach their workspace doc (workspaceId: null)', async () => {
      const owner = await createUser()
      const ws = await createWorkspace(owner.id)
      const doc = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId })
      const client = await loggedInClient(owner.id)
      const res = await client.patch(`/api/docs/${doc.docId}/workspace`, { workspaceId: null })
      expect(res.status).toBe(200)
      expect(await readWorkspaceId(doc.docId)).toBeNull()
    })

    it('workspace admin can move a doc they don\'t own (canManageDoc=true)', async () => {
      const creator = await createUser()
      const admin = await createUser()
      const srcWs = await createWorkspace(creator.id)
      const tgtWs = await createWorkspace(admin.id)
      await setMemberRole(srcWs.workspaceId, admin.id, 'admin')
      const doc = await createDoc({
        ownerId: creator.id,
        workspaceId: srcWs.workspaceId,
        accessMode: 'private'
      })
      const client = await loggedInClient(admin.id)
      const res = await client.patch(`/api/docs/${doc.docId}/workspace`, {
        workspaceId: tgtWs.workspaceId
      })
      expect(res.status).toBe(200)
      expect(await readWorkspaceId(doc.docId)).toBe(tgtWs.workspaceId)
    })

    it('workspace editor CANNOT move a doc (manage rights only, regression guard)', async () => {
      // If this flips to 200, workspace editors can yank docs out of
      // the workspace — not a content edit, a sharing change.
      const creator = await createUser()
      const editor = await createUser()
      const ws = await createWorkspace(creator.id)
      await setMemberRole(ws.workspaceId, editor.id, 'editor')
      const doc = await createDoc({
        ownerId: creator.id,
        workspaceId: ws.workspaceId,
        accessMode: 'private'
      })
      const client = await loggedInClient(editor.id)
      const res = await client.patch(`/api/docs/${doc.docId}/workspace`, { workspaceId: null })
      expect(res.status).toBe(403)
      expect(await readWorkspaceId(doc.docId)).toBe(ws.workspaceId)
    })

    it('workspace viewer cannot move (403)', async () => {
      const creator = await createUser()
      const viewer = await createUser()
      const ws = await createWorkspace(creator.id)
      await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
      const doc = await createDoc({
        ownerId: creator.id,
        workspaceId: ws.workspaceId
      })
      const client = await loggedInClient(viewer.id)
      const res = await client.patch(`/api/docs/${doc.docId}/workspace`, { workspaceId: null })
      expect(res.status).toBe(403)
    })

    it('non-member of source workspace cannot move', async () => {
      const owner = await createUser()
      const stranger = await createUser()
      const ws = await createWorkspace(owner.id)
      const doc = await createDoc({
        ownerId: owner.id,
        workspaceId: ws.workspaceId,
        accessMode: 'open-edit'
      })
      const client = await loggedInClient(stranger.id)
      const res = await client.patch(`/api/docs/${doc.docId}/workspace`, { workspaceId: null })
      expect(res.status).toBe(403)
    })
  })

  describe('target-side authz', () => {
    it('rejects target workspace the actor is not a member of', async () => {
      const owner = await createUser()
      const otherAdmin = await createUser()
      const otherWs = await createWorkspace(otherAdmin.id)
      const doc = await createDoc({ ownerId: owner.id })
      const client = await loggedInClient(owner.id)
      const res = await client.patch(`/api/docs/${doc.docId}/workspace`, {
        workspaceId: otherWs.workspaceId
      })
      expect(res.status).toBe(403)
      expect(await readWorkspaceId(doc.docId)).toBeNull()
    })

    it('rejects target workspace where the actor is only a viewer', async () => {
      const owner = await createUser()
      const viewerUser = await createUser()
      // Set up: owner owns the doc. The doc-owner is also a VIEWER of
      // the target workspace. They pass the source authz (owner) but
      // must fail the target authz (viewer != editor/admin).
      const wsOwner = await createUser()
      const targetWs = await createWorkspace(wsOwner.id)
      await setMemberRole(targetWs.workspaceId, owner.id, 'viewer')
      const doc = await createDoc({ ownerId: owner.id })
      const _unused = viewerUser // avoid unused-var lint
      void _unused

      const client = await loggedInClient(owner.id)
      const res = await client.patch(`/api/docs/${doc.docId}/workspace`, {
        workspaceId: targetWs.workspaceId
      })
      expect(res.status).toBe(403)
    })

    it('accepts target workspace where the actor is an editor', async () => {
      const owner = await createUser()
      const wsOwner = await createUser()
      const targetWs = await createWorkspace(wsOwner.id)
      await setMemberRole(targetWs.workspaceId, owner.id, 'editor')
      const doc = await createDoc({ ownerId: owner.id })

      const client = await loggedInClient(owner.id)
      const res = await client.patch(`/api/docs/${doc.docId}/workspace`, {
        workspaceId: targetWs.workspaceId
      })
      expect(res.status).toBe(200)
      expect(await readWorkspaceId(doc.docId)).toBe(targetWs.workspaceId)
    })
  })

  describe('no-op handling', () => {
    it('same-workspace PATCH is a 200 no-op (no spurious lastActive bump)', async () => {
      // Clients may resend the move if the modal closes and reopens.
      // The handler short-circuits before touching the row — pin this
      // so we don't introduce a lastActive ripple on redundant saves.
      const owner = await createUser()
      const ws = await createWorkspace(owner.id)
      const doc = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId })
      const db = testDb()
      await db.query(
        `UPDATE documents SET last_active = now() - interval '1 day' WHERE doc_id = $1`,
        [doc.docId]
      )
      const beforeRow = (await db.query<{ last_active: Date }>(
        'SELECT last_active FROM documents WHERE doc_id = $1', [doc.docId]
      )).rows[0]

      const client = await loggedInClient(owner.id)
      const res = await client.patch(`/api/docs/${doc.docId}/workspace`, {
        workspaceId: ws.workspaceId
      })
      expect(res.status).toBe(200)

      const afterRow = (await db.query<{ last_active: Date }>(
        'SELECT last_active FROM documents WHERE doc_id = $1', [doc.docId]
      )).rows[0]
      expect(afterRow.last_active.getTime()).toBe(beforeRow.last_active.getTime())
    })

    it('returns the settled workspaceId in the response body', async () => {
      const owner = await createUser()
      const ws = await createWorkspace(owner.id)
      const doc = await createDoc({ ownerId: owner.id })
      const client = await loggedInClient(owner.id)
      const res = await client.patch(`/api/docs/${doc.docId}/workspace`, {
        workspaceId: ws.workspaceId
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { success: boolean, workspaceId: string | null }
      expect(body.success).toBe(true)
      expect(body.workspaceId).toBe(ws.workspaceId)
    })
  })
})
