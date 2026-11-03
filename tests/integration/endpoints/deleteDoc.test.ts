import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import {
  createDoc,
  createUser,
  createWorkspace,
  setMemberRole
} from '../setup/fixtures'
import { createAnonDoc as createAnonDocViaGate } from '../setup/anonGate'

// DELETE /api/docs/:docId. Bug-fix regression target: pre-fix, anonymous
// docs could never be deleted — no session = no authz path.
//
// Current rules (per decideDocDelete):
//   - Anonymous doc (no owner, no workspace, open-edit) → only the browser
//     that created it (creator-key cookie)
//   - Owned standalone → owner only (401 anon, 403 non-owner)
//   - Workspace doc → owner or admin

async function docExists(docId: string): Promise<boolean> {
  const db = testDb()
  const r = await db.query('SELECT 1 FROM documents WHERE doc_id = $1', [docId])
  return r.rowCount === 1
}

describe('DELETE /api/docs/:docId', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns 404 for a nonexistent doc', async () => {
    const owner = await createUser()
    const client = await loggedInClient(owner.id)
    const res = await client.delete('/api/docs/nonexistent')
    expect(res.status).toBe(404)
  })

  describe('anonymous (no-owner) doc', () => {
    // Only the browser that created an anonymous doc may delete it: the
    // creation response sets an httpOnly creator-key cookie whose hash is
    // stored on the row. Others can still edit an open-edit doc.
    async function createAnonDoc(client: ReturnType<typeof anonClient>): Promise<string> {
      const res = await createAnonDocViaGate(client)
      expect(res.status).toBe(200)
      const body = await res.json() as { docId: string }
      return body.docId
    }

    it('the creating browser can delete its anonymous doc', async () => {
      const creator = anonClient()
      const docId = await createAnonDoc(creator)
      const res = await creator.delete(`/api/docs/${docId}`)
      expect(res.status).toBe(200)
      expect(await docExists(docId)).toBe(false)
    })

    it('stores only a hash of the creator key on the row', async () => {
      const creator = anonClient()
      const docId = await createAnonDoc(creator)
      const r = await testDb().query<{ h: string | null }>(
        'SELECT anon_creator_key_hash AS h FROM documents WHERE doc_id = $1',
        [docId]
      )
      expect(r.rows[0]?.h).toMatch(/^[0-9a-f]{64}$/)
      expect(creator.cookieHeader()).not.toContain(r.rows[0]?.h ?? 'missing')
    })

    it('one browser key covers every doc it created', async () => {
      const creator = anonClient()
      const a = await createAnonDoc(creator)
      const b = await createAnonDoc(creator)
      expect((await creator.delete(`/api/docs/${a}`)).status).toBe(200)
      expect((await creator.delete(`/api/docs/${b}`)).status).toBe(200)
    })

    it('another anonymous browser cannot delete it (403)', async () => {
      const docId = await createAnonDoc(anonClient())
      const res = await anonClient().delete(`/api/docs/${docId}`)
      expect(res.status).toBe(403)
      expect(await docExists(docId)).toBe(true)
    })

    it('a logged-in non-creator cannot delete it (403)', async () => {
      const docId = await createAnonDoc(anonClient())
      const someone = await createUser()
      const client = await loggedInClient(someone.id)
      const res = await client.delete(`/api/docs/${docId}`)
      expect(res.status).toBe(403)
      expect(await docExists(docId)).toBe(true)
    })

    it('a legacy anonymous doc without a stored key cannot be deleted through the API', async () => {
      const doc = await createDoc({ accessMode: 'open-edit' })
      expect((await anonClient().delete(`/api/docs/${doc.docId}`)).status).toBe(403)
      expect(await docExists(doc.docId)).toBe(true)
    })

    it('the token endpoint reports canDelete only to the creating browser', async () => {
      const creator = anonClient()
      const docId = await createAnonDoc(creator)
      const mine = await (await creator.get(`/api/docs/${docId}/token`)).json() as { canDelete: boolean, readOnly: boolean }
      const theirs = await (await anonClient().get(`/api/docs/${docId}/token`)).json() as { canDelete: boolean, readOnly: boolean }
      expect(mine.canDelete).toBe(true)
      expect(theirs.canDelete).toBe(false)
      // Others can still edit the open-edit doc.
      expect(theirs.readOnly).toBe(false)
    })
  })

  describe('owned standalone doc (no workspace)', () => {
    it('owner can delete', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id)
      const res = await client.delete(`/api/docs/${doc.docId}`)
      expect(res.status).toBe(200)
      expect(await docExists(doc.docId)).toBe(false)
    })

    it('anonymous cannot delete (401)', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const res = await anonClient().delete(`/api/docs/${doc.docId}`)
      expect(res.status).toBe(401)
      expect(await docExists(doc.docId)).toBe(true)
    })

    it('logged-in non-owner cannot delete (403)', async () => {
      const owner = await createUser()
      const other = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(other.id)
      const res = await client.delete(`/api/docs/${doc.docId}`)
      expect(res.status).toBe(403)
      expect(await docExists(doc.docId)).toBe(true)
    })

    it.each(['open-edit', 'open-view', 'password-protected'] as const)(
      'access mode %s does not let strangers delete',
      async (mode) => {
        const owner = await createUser()
        const stranger = await createUser()
        const doc = await createDoc({ ownerId: owner.id, accessMode: mode })
        const client = await loggedInClient(stranger.id)
        const res = await client.delete(`/api/docs/${doc.docId}`)
        expect(res.status).toBe(403)
        expect(await docExists(doc.docId)).toBe(true)
      }
    )
  })

  describe('workspace doc', () => {
    it('owner can delete their own workspace doc', async () => {
      const owner = await createUser()
      const ws = await createWorkspace(owner.id)
      const doc = await createDoc({
        ownerId: owner.id,
        workspaceId: ws.workspaceId,
        accessMode: 'private'
      })
      const client = await loggedInClient(owner.id)
      const res = await client.delete(`/api/docs/${doc.docId}`)
      expect(res.status).toBe(200)
    })

    it('workspace admin can delete another member\'s doc', async () => {
      const creator = await createUser()
      const admin = await createUser()
      const ws = await createWorkspace(creator.id)
      await setMemberRole(ws.workspaceId, admin.id, 'admin')
      const doc = await createDoc({
        ownerId: creator.id,
        workspaceId: ws.workspaceId,
        accessMode: 'private'
      })
      const client = await loggedInClient(admin.id)
      const res = await client.delete(`/api/docs/${doc.docId}`)
      expect(res.status).toBe(200)
    })

    it('workspace editor cannot delete someone else\'s doc (403)', async () => {
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
      const res = await client.delete(`/api/docs/${doc.docId}`)
      expect(res.status).toBe(403)
      expect(await docExists(doc.docId)).toBe(true)
    })

    it('workspace viewer cannot delete', async () => {
      const creator = await createUser()
      const viewer = await createUser()
      const ws = await createWorkspace(creator.id)
      await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
      const doc = await createDoc({
        ownerId: creator.id,
        workspaceId: ws.workspaceId,
        accessMode: 'private'
      })
      const client = await loggedInClient(viewer.id)
      const res = await client.delete(`/api/docs/${doc.docId}`)
      expect(res.status).toBe(403)
      expect(await docExists(doc.docId)).toBe(true)
    })

    it('editor can delete their own doc via the owner path', async () => {
      const creator = await createUser()
      const editor = await createUser()
      const ws = await createWorkspace(creator.id)
      await setMemberRole(ws.workspaceId, editor.id, 'editor')
      const doc = await createDoc({
        ownerId: editor.id, // owned by the editor
        workspaceId: ws.workspaceId,
        accessMode: 'private'
      })
      const client = await loggedInClient(editor.id)
      const res = await client.delete(`/api/docs/${doc.docId}`)
      expect(res.status).toBe(200)
    })

    it('non-member of the workspace is forbidden', async () => {
      const creator = await createUser()
      const stranger = await createUser()
      const ws = await createWorkspace(creator.id)
      const doc = await createDoc({
        ownerId: creator.id,
        workspaceId: ws.workspaceId,
        accessMode: 'private'
      })
      const client = await loggedInClient(stranger.id)
      const res = await client.delete(`/api/docs/${doc.docId}`)
      expect(res.status).toBe(403)
    })
  })
})
