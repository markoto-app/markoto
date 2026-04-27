import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import {
  createUser,
  createWorkspace,
  setMemberRole
} from '../setup/fixtures'

// POST /api/docs — creates a document. Defaults matter:
//   - Anonymous creator → ownerId=null, accessMode='open-edit'
//   - Logged-in creator → ownerId=user.id, accessMode='private'
// These defaults are load-bearing: anonymous-private would lock the
// creator out (no stable identity); logged-in-open-edit would publish
// every new doc.
//
// Workspace assignment: admin / editor may file a new doc into a workspace
// they belong to. Viewers cannot. Anonymous callers never.

async function readDoc(docId: string) {
  const db = testDb()
  const r = await db.query<{
    owner_id: number | null
    workspace_id: string | null
    access_mode: string
    title: string
    description: string
    audience: string
    language: string
    template_id: string
    theme: { color?: { brand?: string } } | null
  }>(
    `SELECT owner_id, workspace_id, access_mode, title, description, audience, language, template_id, theme
     FROM documents WHERE doc_id = $1`,
    [docId]
  )
  return r.rows[0]
}

describe('POST /api/docs', () => {
  beforeEach(async () => {
    await resetDb()
  })

  describe('default visibility', () => {
    it('anonymous creator gets open-edit, no owner', async () => {
      const res = await anonClient().post('/api/docs', {})
      expect(res.status).toBe(200)
      const { docId } = await res.json() as { docId: string }
      const row = await readDoc(docId)
      expect(row.owner_id).toBeNull()
      expect(row.access_mode).toBe('open-edit')
      expect(row.workspace_id).toBeNull()
    })

    it('logged-in creator gets private + ownerId set', async () => {
      const user = await createUser()
      const client = await loggedInClient(user.id)
      const res = await client.post('/api/docs', {})
      expect(res.status).toBe(200)
      const { docId } = await res.json() as { docId: string }
      const row = await readDoc(docId)
      expect(row.owner_id).toBe(user.id)
      expect(row.access_mode).toBe('private')
      expect(row.workspace_id).toBeNull()
    })
  })

  describe('workspace assignment', () => {
    it('admin can file new doc into their workspace', async () => {
      const admin = await createUser()
      const ws = await createWorkspace(admin.id)
      const client = await loggedInClient(admin.id)
      const res = await client.post('/api/docs', { workspaceId: ws.workspaceId })
      expect(res.status).toBe(200)
      const { docId } = await res.json() as { docId: string }
      const row = await readDoc(docId)
      expect(row.workspace_id).toBe(ws.workspaceId)
      expect(row.owner_id).toBe(admin.id)
    })

    it('editor can file new doc into a workspace they belong to', async () => {
      const admin = await createUser()
      const editor = await createUser()
      const ws = await createWorkspace(admin.id)
      await setMemberRole(ws.workspaceId, editor.id, 'editor')
      const client = await loggedInClient(editor.id)
      const res = await client.post('/api/docs', { workspaceId: ws.workspaceId })
      expect(res.status).toBe(200)
      const { docId } = await res.json() as { docId: string }
      expect((await readDoc(docId)).workspace_id).toBe(ws.workspaceId)
    })

    it('viewer cannot create docs in workspace (403)', async () => {
      const admin = await createUser()
      const viewer = await createUser()
      const ws = await createWorkspace(admin.id)
      await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
      const client = await loggedInClient(viewer.id)
      const res = await client.post('/api/docs', { workspaceId: ws.workspaceId })
      expect(res.status).toBe(403)
    })

    it('non-member of workspace gets 403', async () => {
      const admin = await createUser()
      const stranger = await createUser()
      const ws = await createWorkspace(admin.id)
      const client = await loggedInClient(stranger.id)
      const res = await client.post('/api/docs', { workspaceId: ws.workspaceId })
      expect(res.status).toBe(403)
    })

    it('anonymous caller cannot use a workspaceId at all (401)', async () => {
      const admin = await createUser()
      const ws = await createWorkspace(admin.id)
      const res = await anonClient().post('/api/docs', { workspaceId: ws.workspaceId })
      expect(res.status).toBe(401)
    })

    it('empty/missing workspaceId is accepted as "no workspace"', async () => {
      const user = await createUser()
      const client = await loggedInClient(user.id)
      const res1 = await client.post('/api/docs', { workspaceId: '' })
      const res2 = await client.post('/api/docs', { workspaceId: null })
      expect(res1.status).toBe(200)
      expect(res2.status).toBe(200)
    })
  })

  // Doc context fields shipped by the new-doc dialog. Each is optional;
  // omitted fields fall back to schema defaults so the legacy zero-config
  // POST path (and the dialog's "Just give me a blank doc" button) still
  // produces sensible values.
  describe('doc context fields', () => {
    it('empty body falls back to all schema defaults', async () => {
      const user = await createUser()
      const client = await loggedInClient(user.id)
      const res = await client.post('/api/docs', {})
      expect(res.status).toBe(200)
      const { docId } = await res.json() as { docId: string }
      const row = await readDoc(docId)
      expect(row.title).toBe('Untitled')
      expect(row.description).toBe('')
      expect(row.audience).toBe('casual')
      expect(row.language).toBe('en')
      expect(row.template_id).toBe('blank')
      expect(row.theme).toBeNull()
    })

    it('accepts and persists all dialog fields', async () => {
      const user = await createUser()
      const client = await loggedInClient(user.id)
      const res = await client.post('/api/docs', {
        title: 'RFC: New billing model',
        description: 'Per-interaction billing',
        audience: 'technical',
        language: 'de',
        templateId: 'business-plan',
        themePreset: 'academic'
      })
      expect(res.status).toBe(200)
      const { docId } = await res.json() as { docId: string }
      const row = await readDoc(docId)
      expect(row.title).toBe('RFC: New billing model')
      expect(row.description).toBe('Per-interaction billing')
      expect(row.audience).toBe('technical')
      expect(row.language).toBe('de')
      expect(row.template_id).toBe('business-plan')
      // themePreset resolves server-side to the academic preset's full
      // theme object — client cannot inject arbitrary JSONB.
      expect(row.theme).not.toBeNull()
      expect(row.theme).toHaveProperty('color')
    })

    it('accepts free-text language strings', async () => {
      const user = await createUser()
      const client = await loggedInClient(user.id)
      const res = await client.post('/api/docs', { language: 'Schwiizerdütsch' })
      expect(res.status).toBe(200)
      const { docId } = await res.json() as { docId: string }
      expect((await readDoc(docId)).language).toBe('Schwiizerdütsch')
    })

    it('rejects unknown audience (400)', async () => {
      const user = await createUser()
      const client = await loggedInClient(user.id)
      const res = await client.post('/api/docs', { audience: 'nonsense' })
      expect(res.status).toBe(400)
    })

    it('rejects unknown templateId (400)', async () => {
      const user = await createUser()
      const client = await loggedInClient(user.id)
      const res = await client.post('/api/docs', { templateId: 'fake-template' })
      expect(res.status).toBe(400)
    })

    it('rejects unknown themePreset (400)', async () => {
      const user = await createUser()
      const client = await loggedInClient(user.id)
      const res = await client.post('/api/docs', { themePreset: 'punk-rock' })
      expect(res.status).toBe(400)
    })

    it('rejects oversized description (>500 chars, 400)', async () => {
      const user = await createUser()
      const client = await loggedInClient(user.id)
      const res = await client.post('/api/docs', { description: 'x'.repeat(501) })
      expect(res.status).toBe(400)
    })

    it('rejects oversized language (>50 chars, 400)', async () => {
      const user = await createUser()
      const client = await loggedInClient(user.id)
      const res = await client.post('/api/docs', { language: 'x'.repeat(51) })
      expect(res.status).toBe(400)
    })

    it('rejects empty (whitespace-only) language (400)', async () => {
      const user = await createUser()
      const client = await loggedInClient(user.id)
      const res = await client.post('/api/docs', { language: '   ' })
      expect(res.status).toBe(400)
    })

    it('trims whitespace from title and description', async () => {
      const user = await createUser()
      const client = await loggedInClient(user.id)
      const res = await client.post('/api/docs', {
        title: '  Hello  ',
        description: '  About  '
      })
      expect(res.status).toBe(200)
      const { docId } = await res.json() as { docId: string }
      const row = await readDoc(docId)
      expect(row.title).toBe('Hello')
      expect(row.description).toBe('About')
    })

    it('anonymous caller can pass dialog fields (no workspace)', async () => {
      const res = await anonClient().post('/api/docs', {
        title: 'Anon doc',
        audience: 'creative',
        language: 'fr'
      })
      expect(res.status).toBe(200)
      const { docId } = await res.json() as { docId: string }
      const row = await readDoc(docId)
      expect(row.title).toBe('Anon doc')
      expect(row.audience).toBe('creative')
      expect(row.language).toBe('fr')
      expect(row.owner_id).toBeNull()
    })
  })
})
