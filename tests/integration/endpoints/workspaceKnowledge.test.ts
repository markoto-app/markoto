import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import {
  createUser,
  createWorkspace,
  setMemberRole
} from '../setup/fixtures'

// Knowledge-base REST endpoints. These cover the DB + authz surface.
// Upload-request issues a presigned S3 URL, we don't exercise the PUT
// itself (that's S3's problem); confirm + list + delete are tested
// against seeded rows. processKnowledge() runs fire-and-forget and is
// not covered here (needs markitdown); its failure path is exercised
// via the sweep plugin.

interface KnowledgeRow {
  knowledge_id: string
  workspace_id: string
  filename: string
  status: string
  uploader_id: number | null
  size_bytes: number
}

async function seedKnowledge(
  overrides: Partial<KnowledgeRow> & { workspace_id: string, knowledge_id?: string, filename?: string }
): Promise<KnowledgeRow> {
  const db = testDb()
  const row: KnowledgeRow = {
    knowledge_id: overrides.knowledge_id ?? `kn-${Math.random().toString(36).slice(2, 10)}`,
    workspace_id: overrides.workspace_id,
    filename: overrides.filename ?? 'sample.pdf',
    status: overrides.status ?? 'ready',
    uploader_id: overrides.uploader_id ?? null,
    size_bytes: overrides.size_bytes ?? 1024
  }
  await db.query(
    `INSERT INTO workspace_knowledge
     (knowledge_id, workspace_id, filename, source_ext, mime_type, size_bytes, s3_key, status, embedding_version, uploader_id, chunk_count, token_count)
     VALUES ($1, $2, $3, 'pdf', 'application/pdf', $4, $5, $6, 'test:768', $7, 0, 0)`,
    [
      row.knowledge_id,
      row.workspace_id,
      row.filename,
      row.size_bytes,
      `workspaces/${row.workspace_id}/knowledge/${row.knowledge_id}.pdf`,
      row.status,
      row.uploader_id
    ]
  )
  return row
}

async function countRows(workspaceId: string): Promise<number> {
  const db = testDb()
  const r = await db.query<{ c: string }>(
    'SELECT COUNT(*) AS c FROM workspace_knowledge WHERE workspace_id = $1',
    [workspaceId]
  )
  return Number(r.rows[0]?.c ?? 0)
}

describe('POST /api/workspaces/:wsId/knowledge/upload-request', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('401 for anonymous callers', async () => {
    const res = await anonClient().post('/api/workspaces/ws-anything/knowledge/upload-request', {
      filename: 'x.pdf',
      size: 1024
    })
    expect(res.status).toBe(401)
  })

  it('404 for non-members (avoids leaking workspace existence)', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const outsider = await createUser()
    const client = await loggedInClient(outsider.id)
    const res = await client.post(`/api/workspaces/${ws.workspaceId}/knowledge/upload-request`, {
      filename: 'x.pdf',
      size: 1024
    })
    expect(res.status).toBe(404)
  })

  it('403 for viewers (can see knowledge but not upload)', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const viewer = await createUser()
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
    const client = await loggedInClient(viewer.id)
    const res = await client.post(`/api/workspaces/${ws.workspaceId}/knowledge/upload-request`, {
      filename: 'x.pdf',
      size: 1024
    })
    expect(res.status).toBe(403)
  })

  it('415 for unsupported extensions', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const client = await loggedInClient(owner.id)
    const res = await client.post(`/api/workspaces/${ws.workspaceId}/knowledge/upload-request`, {
      filename: 'malware.exe',
      size: 1024
    })
    expect(res.status).toBe(415)
  })

  it('413 when file exceeds maxFileBytes', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const client = await loggedInClient(owner.id)
    // Default cap is 25 MB, go just above.
    const res = await client.post(`/api/workspaces/${ws.workspaceId}/knowledge/upload-request`, {
      filename: 'big.pdf',
      size: 26 * 1024 * 1024
    })
    expect(res.status).toBe(413)
  })

  it('admin can request a presigned URL', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const client = await loggedInClient(owner.id)
    const res = await client.post(`/api/workspaces/${ws.workspaceId}/knowledge/upload-request`, {
      filename: 'brief.pdf',
      size: 10_000
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { knowledgeId: string, uploadUrl: string, s3Key: string, ext: string, mimeType: string }
    expect(body.knowledgeId).toBeTruthy()
    expect(body.uploadUrl).toMatch(/^https?:\/\//)
    expect(body.s3Key).toBe(`workspaces/${ws.workspaceId}/knowledge/${body.knowledgeId}.pdf`)
    expect(body.ext).toBe('pdf')
    expect(body.mimeType).toBe('application/pdf')
  })

  it('editor can request a presigned URL', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const editor = await createUser()
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    const client = await loggedInClient(editor.id)
    const res = await client.post(`/api/workspaces/${ws.workspaceId}/knowledge/upload-request`, {
      filename: 'notes.docx',
      size: 5000
    })
    expect(res.status).toBe(200)
  })
})

describe('GET /api/workspaces/:wsId/knowledge', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('401 for anonymous', async () => {
    const res = await anonClient().get('/api/workspaces/ws-any/knowledge')
    expect(res.status).toBe(401)
  })

  it('404 for non-members', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const outsider = await createUser()
    const client = await loggedInClient(outsider.id)
    const res = await client.get(`/api/workspaces/${ws.workspaceId}/knowledge`)
    expect(res.status).toBe(404)
  })

  it('any role (including viewer) can list', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    await seedKnowledge({ workspace_id: ws.workspaceId, filename: 'a.pdf' })
    await seedKnowledge({ workspace_id: ws.workspaceId, filename: 'b.pdf' })
    const viewer = await createUser()
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
    const client = await loggedInClient(viewer.id)
    const res = await client.get(`/api/workspaces/${ws.workspaceId}/knowledge`)
    expect(res.status).toBe(200)
    const body = await res.json() as { items: Array<{ filename: string }>, usage: { count: number } }
    expect(body.items).toHaveLength(2)
    expect(body.usage.count).toBe(2)
  })

  it('response excludes markdownCache even when present', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const kn = await seedKnowledge({ workspace_id: ws.workspaceId })
    const db = testDb()
    await db.query(
      'UPDATE workspace_knowledge SET markdown_cache = $1 WHERE knowledge_id = $2',
      ['# Secret content that should not appear in list payload', kn.knowledge_id]
    )
    const client = await loggedInClient(owner.id)
    const res = await client.get(`/api/workspaces/${ws.workspaceId}/knowledge`)
    const body = await res.text()
    expect(body).not.toContain('Secret content')
  })
})

describe('POST /api/workspaces/:wsId/knowledge/confirm: input binding', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('400 when knowledgeId does not match s3Key tail', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const client = await loggedInClient(owner.id)
    const res = await client.post(`/api/workspaces/${ws.workspaceId}/knowledge/confirm`, {
      // knowledgeId A, but s3Key names knowledgeId B, reject before
      // any S3 or DB work.
      knowledgeId: 'a'.repeat(12),
      s3Key: `workspaces/${ws.workspaceId}/knowledge/${'b'.repeat(12)}.pdf`,
      filename: 'x.pdf',
      ext: 'pdf',
      mimeType: 'application/pdf'
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { message: string }
    expect(body.message).toMatch(/knowledgeId.*s3Key/i)
  })
})

describe('per-user knowledge caps', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('409 when the caller has hit their per-user file count across workspaces', async () => {
    const u = await createUser()
    const wsA = await createWorkspace(u.id)
    const wsB = await createWorkspace(u.id, { workspaceId: 'ws-user-fanout' })
    // Seed 100 rows owned by this user, split across two workspaces,
    // each workspace has 50, well below the 500/workspace cap, but
    // the per-user count (100) matches maxFilesPerUser.
    const db = testDb()
    for (let i = 0; i < 50; i++) {
      await db.query(
        `INSERT INTO workspace_knowledge
         (knowledge_id, workspace_id, filename, source_ext, mime_type, size_bytes, s3_key, status, embedding_version, uploader_id, chunk_count, token_count)
         VALUES ($1, $2, $3, 'pdf', 'application/pdf', 1000, $4, 'ready', 'test:768', $5, 0, 0)`,
        [`kn-a-${i}`, wsA.workspaceId, `file-a-${i}.pdf`, `workspaces/${wsA.workspaceId}/knowledge/kn-a-${i}.pdf`, u.id]
      )
    }
    for (let i = 0; i < 50; i++) {
      await db.query(
        `INSERT INTO workspace_knowledge
         (knowledge_id, workspace_id, filename, source_ext, mime_type, size_bytes, s3_key, status, embedding_version, uploader_id, chunk_count, token_count)
         VALUES ($1, $2, $3, 'pdf', 'application/pdf', 1000, $4, 'ready', 'test:768', $5, 0, 0)`,
        [`kn-b-${i}`, wsB.workspaceId, `file-b-${i}.pdf`, `workspaces/${wsB.workspaceId}/knowledge/kn-b-${i}.pdf`, u.id]
      )
    }
    const client = await loggedInClient(u.id)
    const res = await client.post(`/api/workspaces/${wsA.workspaceId}/knowledge/upload-request`, {
      filename: 'another.pdf',
      size: 1000
    })
    expect(res.status).toBe(409)
  })
})

describe('POST /api/workspaces: per-user workspace cap', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('409 once the user has hit maxPerUser owned workspaces', async () => {
    const u = await createUser()
    // Seed 20 owned workspaces (the default cap).
    const db = testDb()
    for (let i = 0; i < 20; i++) {
      await db.query(
        `INSERT INTO workspaces (workspace_id, owner_id, name) VALUES ($1, $2, $3)`,
        [`ws-cap-${i}`, u.id, `Cap ${i}`]
      )
      await db.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`,
        [`ws-cap-${i}`, u.id]
      )
    }
    const client = await loggedInClient(u.id)
    const res = await client.post('/api/workspaces', { name: 'Overflow' })
    expect(res.status).toBe(409)
  })
})

describe('DELETE /api/workspaces/:wsId/knowledge/:id', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('404 when the knowledge row belongs to a different workspace (no probing)', async () => {
    const owner = await createUser()
    const wsA = await createWorkspace(owner.id)
    const wsB = await createWorkspace(owner.id, { workspaceId: `ws-other-${Date.now()}` })
    const kn = await seedKnowledge({ workspace_id: wsB.workspaceId })
    const client = await loggedInClient(owner.id)
    const res = await client.delete(`/api/workspaces/${wsA.workspaceId}/knowledge/${kn.knowledge_id}`)
    expect(res.status).toBe(404)
    expect(await countRows(wsB.workspaceId)).toBe(1)
  })

  it('admin can delete any upload in their workspace', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const editor = await createUser()
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    const kn = await seedKnowledge({ workspace_id: ws.workspaceId, uploader_id: editor.id })
    const client = await loggedInClient(admin.id)
    const res = await client.delete(`/api/workspaces/${ws.workspaceId}/knowledge/${kn.knowledge_id}`)
    expect(res.status).toBe(200)
    expect(await countRows(ws.workspaceId)).toBe(0)
  })

  it('editor can delete their own upload', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const editor = await createUser()
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    const kn = await seedKnowledge({ workspace_id: ws.workspaceId, uploader_id: editor.id })
    const client = await loggedInClient(editor.id)
    const res = await client.delete(`/api/workspaces/${ws.workspaceId}/knowledge/${kn.knowledge_id}`)
    expect(res.status).toBe(200)
  })

  it('editor cannot delete another user\'s upload', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const editor = await createUser()
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    // Upload attributed to admin; editor tries to delete.
    const kn = await seedKnowledge({ workspace_id: ws.workspaceId, uploader_id: admin.id })
    const client = await loggedInClient(editor.id)
    const res = await client.delete(`/api/workspaces/${ws.workspaceId}/knowledge/${kn.knowledge_id}`)
    expect(res.status).toBe(403)
    expect(await countRows(ws.workspaceId)).toBe(1)
  })

  it('viewer cannot delete at all', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const viewer = await createUser()
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
    const kn = await seedKnowledge({ workspace_id: ws.workspaceId })
    const client = await loggedInClient(viewer.id)
    const res = await client.delete(`/api/workspaces/${ws.workspaceId}/knowledge/${kn.knowledge_id}`)
    expect(res.status).toBe(403)
  })
})

// The role rules every knowledge route applies, one table: viewers list,
// editors upload / confirm / delete their own, admins delete any (also an
// upload whose uploader is gone), guests and outsiders get 404 everywhere.
describe('knowledge role rules across the routes', () => {
  beforeEach(async () => {
    await resetDb()
  })

  async function codeOf(res: Response): Promise<string | undefined> {
    return (await res.json() as { data?: { code?: string } }).data?.code
  }

  it('guests of the workspace get 404 on every knowledge route', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const guest = await createUser()
    await setMemberRole(ws.workspaceId, guest.id, 'guest')
    const kn = await seedKnowledge({ workspace_id: ws.workspaceId, uploader_id: guest.id })
    const client = await loggedInClient(guest.id)
    const base = `/api/workspaces/${ws.workspaceId}/knowledge`
    for (const res of [
      await client.get(base),
      await client.post(`${base}/upload-request`, { filename: 'notes.md', size: 10 }),
      await client.post(`${base}/confirm`, { knowledgeId: kn.knowledge_id, s3Key: `workspaces/${ws.workspaceId}/knowledge/${kn.knowledge_id}.md`, filename: 'notes.md', ext: 'md', mimeType: 'text/markdown' }),
      await client.delete(`${base}/${kn.knowledge_id}`)
    ]) {
      expect(res.status).toBe(404)
      expect(await codeOf(res)).toBe('workspace/not-found')
    }
    expect(await countRows(ws.workspaceId)).toBe(1)
  })

  it('viewers may not confirm an upload (403 knowledge/editor-required)', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const viewer = await createUser()
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
    const client = await loggedInClient(viewer.id)
    const res = await client.post(`/api/workspaces/${ws.workspaceId}/knowledge/confirm`, { knowledgeId: 'kn-x', s3Key: `workspaces/${ws.workspaceId}/knowledge/kn-x.md`, filename: 'notes.md', ext: 'md', mimeType: 'text/markdown' })
    expect(res.status).toBe(403)
    expect(await codeOf(res)).toBe('knowledge/editor-required')
  })

  it('an upload without an uploader: only an admin may delete it', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const editor = await createUser()
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    const kn = await seedKnowledge({ workspace_id: ws.workspaceId, uploader_id: null })
    const asEditor = await (await loggedInClient(editor.id)).delete(`/api/workspaces/${ws.workspaceId}/knowledge/${kn.knowledge_id}`)
    expect(asEditor.status).toBe(403)
    expect(await codeOf(asEditor)).toBe('knowledge/not-uploader')
    expect((await (await loggedInClient(admin.id)).delete(`/api/workspaces/${ws.workspaceId}/knowledge/${kn.knowledge_id}`)).status).toBe(200)
    expect(await countRows(ws.workspaceId)).toBe(0)
  })
})
