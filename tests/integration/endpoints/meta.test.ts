import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import {
  createDoc,
  createUser,
  createWorkspace,
  setMemberRole
} from '../setup/fixtures'
import { first } from '../../helpers/assert'

// PUT /api/docs/:docId/meta — splits into two authz bands:
//   - Content edits (title, wordCount, sizeBytes, theme) → canEdit
//       (owner, workspace admin, workspace editor)
//   - Access-mode change → canManage
//       (owner, workspace admin ONLY — editors CANNOT change access)
//
// That split is load-bearing: if a workspace editor can flip `private` →
// `open-edit` they can expose any doc in the workspace. Tests pin the
// invariant on both directions.

async function readDoc(docId: string) {
  const db = testDb()
  const r = await db.query<{
    title: string
    access_mode: string
    word_count: number | null
    theme: unknown
    description: string
    audience: string
    language: string
  }>(
    `SELECT title, access_mode, word_count, theme, description, audience, language
     FROM documents WHERE doc_id = $1`,
    [docId]
  )
  return first(r.rows, 'documents row')
}

describe('PUT /api/docs/:docId/meta', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('rejects anonymous via middleware (401)', async () => {
    const doc = await createDoc({ accessMode: 'open-edit' })
    const res = await anonClient().put(`/api/docs/${doc.docId}/meta`, { title: 'x' })
    expect(res.status).toBe(401)
  })

  it('returns 404 for a nonexistent doc', async () => {
    const user = await createUser()
    const client = await loggedInClient(user.id)
    const res = await client.put('/api/docs/nonexistent/meta', { title: 'x' })
    expect(res.status).toBe(404)
  })

  describe('title update', () => {
    it('owner can update title', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id)
      const res = await client.put(`/api/docs/${doc.docId}/meta`, { title: 'Renamed' })
      expect(res.status).toBe(200)
      expect((await readDoc(doc.docId)).title).toBe('Renamed')
    })

    it('workspace editor can update title', async () => {
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
      const res = await client.put(`/api/docs/${doc.docId}/meta`, { title: 'Editor retitled' })
      expect(res.status).toBe(200)
      expect((await readDoc(doc.docId)).title).toBe('Editor retitled')
    })

    it('workspace viewer cannot update title (403)', async () => {
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
      const res = await client.put(`/api/docs/${doc.docId}/meta`, { title: 'nope' })
      expect(res.status).toBe(403)
    })

    it('non-member on a private doc gets 403', async () => {
      const owner = await createUser()
      const stranger = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(stranger.id)
      const res = await client.put(`/api/docs/${doc.docId}/meta`, { title: 'hijack' })
      expect(res.status).toBe(403)
    })

    it('rejects title > 255 chars (400)', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id)
      const res = await client.put(`/api/docs/${doc.docId}/meta`, {
        title: 'x'.repeat(256)
      })
      expect(res.status).toBe(400)
    })

    it('rejects non-string title (400)', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id)
      const res = await client.put(`/api/docs/${doc.docId}/meta`, { title: 42 })
      expect(res.status).toBe(400)
    })
  })

  describe('accessMode change (the big invariant)', () => {
    it('owner can flip private → open-edit', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id)
      const res = await client.put(`/api/docs/${doc.docId}/meta`, { accessMode: 'open-edit' })
      expect(res.status).toBe(200)
      expect((await readDoc(doc.docId)).access_mode).toBe('open-edit')
    })

    it('workspace admin can flip accessMode', async () => {
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
      const res = await client.put(`/api/docs/${doc.docId}/meta`, { accessMode: 'open-view' })
      expect(res.status).toBe(200)
      expect((await readDoc(doc.docId)).access_mode).toBe('open-view')
    })

    it('workspace editor CANNOT flip accessMode (403, invariant guard)', async () => {
      // If this ever flips to 200, the editor just escalated an entire
      // workspace doc from private to public.
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
      const res = await client.put(`/api/docs/${doc.docId}/meta`, { accessMode: 'open-edit' })
      expect(res.status).toBe(403)
      expect((await readDoc(doc.docId)).access_mode).toBe('private')
    })

    it('editor passing accessMode along with an allowed field is refused wholesale', async () => {
      // Belt-and-braces regression guard: the handler must not accept
      // "partial" payloads where the allowed field lands and the
      // forbidden field is silently dropped.
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
      const res = await client.put(`/api/docs/${doc.docId}/meta`, {
        title: 'fine',
        accessMode: 'open-edit'
      })
      expect(res.status).toBe(403)
      // Neither field landed.
      const row = await readDoc(doc.docId)
      expect(row.title).not.toBe('fine')
      expect(row.access_mode).toBe('private')
    })

    it('rejects invalid accessMode (400)', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id)
      const res = await client.put(`/api/docs/${doc.docId}/meta`, { accessMode: 'super-open' })
      expect(res.status).toBe(400)
    })
  })

  describe('wordCount and sizeBytes', () => {
    it('accepts sane wordCount', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id)
      const res = await client.put(`/api/docs/${doc.docId}/meta`, { wordCount: 123 })
      expect(res.status).toBe(200)
      expect((await readDoc(doc.docId)).word_count).toBe(123)
    })

    it('rejects negative wordCount (400)', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id)
      const res = await client.put(`/api/docs/${doc.docId}/meta`, { wordCount: -1 })
      expect(res.status).toBe(400)
    })

    it('rejects absurd wordCount (400)', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id)
      const res = await client.put(`/api/docs/${doc.docId}/meta`, { wordCount: 999_999_999 })
      expect(res.status).toBe(400)
    })

    it('rejects absurd sizeBytes (400)', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id)
      const res = await client.put(`/api/docs/${doc.docId}/meta`, { sizeBytes: 200_000_000 })
      expect(res.status).toBe(400)
    })
  })

  describe('theme update', () => {
    it('null resets theme', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id)
      const res = await client.put(`/api/docs/${doc.docId}/meta`, { theme: null })
      expect(res.status).toBe(200)
      expect((await readDoc(doc.docId)).theme).toBeNull()
    })

    it('rejects obviously-invalid theme shape (400)', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id)
      const res = await client.put(`/api/docs/${doc.docId}/meta`, {
        theme: { random: 'garbage' }
      })
      expect(res.status).toBe(400)
    })
  })

  // Doc context fields — same canEdit gate as title/wordCount/theme.
  // Shipped as authoritative AI prompt context, so the validation
  // contract matters: bad enums or oversized strings should never make
  // it into a system prompt.
  describe('doc context fields', () => {
    it('owner can update description', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id)
      const res = await client.put(`/api/docs/${doc.docId}/meta`, {
        description: 'A test description'
      })
      expect(res.status).toBe(200)
      expect((await readDoc(doc.docId)).description).toBe('A test description')
    })

    it('owner can update audience to any of the 6 enum values', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id)
      for (const aud of ['technical', 'marketing', 'academic', 'casual', 'business', 'creative']) {
        const res = await client.put(`/api/docs/${doc.docId}/meta`, { audience: aud })
        expect(res.status).toBe(200)
        expect((await readDoc(doc.docId)).audience).toBe(aud)
      }
    })

    it('owner can update language to a preset OR a free-text value', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id)

      const r1 = await client.put(`/api/docs/${doc.docId}/meta`, { language: 'de' })
      expect(r1.status).toBe(200)
      expect((await readDoc(doc.docId)).language).toBe('de')

      const r2 = await client.put(`/api/docs/${doc.docId}/meta`, { language: 'Schwiizerdütsch' })
      expect(r2.status).toBe(200)
      expect((await readDoc(doc.docId)).language).toBe('Schwiizerdütsch')
    })

    it('workspace editor can update doc context (same gate as content)', async () => {
      const admin = await createUser()
      const editor = await createUser()
      const ws = await createWorkspace(admin.id)
      await setMemberRole(ws.workspaceId, editor.id, 'editor')
      const doc = await createDoc({
        ownerId: admin.id,
        workspaceId: ws.workspaceId,
        accessMode: 'private'
      })
      const client = await loggedInClient(editor.id)
      const res = await client.put(`/api/docs/${doc.docId}/meta`, {
        description: 'Edited by workspace editor',
        audience: 'business'
      })
      expect(res.status).toBe(200)
      const row = await readDoc(doc.docId)
      expect(row.description).toBe('Edited by workspace editor')
      expect(row.audience).toBe('business')
    })

    it('workspace viewer cannot update doc context (403)', async () => {
      const admin = await createUser()
      const viewer = await createUser()
      const ws = await createWorkspace(admin.id)
      await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
      const doc = await createDoc({
        ownerId: admin.id,
        workspaceId: ws.workspaceId,
        accessMode: 'open-view'
      })
      const client = await loggedInClient(viewer.id)
      const res = await client.put(`/api/docs/${doc.docId}/meta`, {
        description: 'should be rejected'
      })
      expect(res.status).toBe(403)
    })

    it('rejects unknown audience (400)', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id)
      const res = await client.put(`/api/docs/${doc.docId}/meta`, { audience: 'nonsense' })
      expect(res.status).toBe(400)
    })

    it('rejects oversized description (>500 chars, 400)', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id)
      const res = await client.put(`/api/docs/${doc.docId}/meta`, {
        description: 'x'.repeat(501)
      })
      expect(res.status).toBe(400)
    })

    it('rejects oversized language (>50 chars, 400)', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id)
      const res = await client.put(`/api/docs/${doc.docId}/meta`, {
        language: 'x'.repeat(51)
      })
      expect(res.status).toBe(400)
    })

    it('rejects empty/whitespace-only language (400)', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id)
      const res = await client.put(`/api/docs/${doc.docId}/meta`, { language: '   ' })
      expect(res.status).toBe(400)
    })

    it('trims whitespace from description', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id)
      const res = await client.put(`/api/docs/${doc.docId}/meta`, {
        description: '  surrounded by space  '
      })
      expect(res.status).toBe(200)
      expect((await readDoc(doc.docId)).description).toBe('surrounded by space')
    })
  })
})
