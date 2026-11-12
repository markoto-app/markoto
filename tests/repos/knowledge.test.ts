import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import {
  createKnowledge,
  disambiguateFilename,
  countWorkspaceKnowledge,
  sumWorkspaceKnowledgeBytes,
  listReadyKnowledgeBrief,
  deleteKnowledgeRow
} from '../../server/repos/knowledge'
import { createUser, createWorkspace } from '../integration/setup/fixtures'
import { wsAs } from '../helpers/access'

// DB-backed tests for the knowledge repo. No S3, no markitdown, no
// embeddings — those are exercised via endpoint tests + unit tests.
// Focus here: filename disambiguation, aggregate counters, the
// brief-list projection used for the AI system prompt.

async function seed(args: {
  workspaceId: string
  uploaderId: number
  filename: string
  status?: 'processing' | 'ready' | 'failed'
  sizeBytes?: number
}): Promise<string> {
  const knowledgeId = `kn-${Math.random().toString(36).slice(2, 10)}`
  await createKnowledge(wsAs(args.workspaceId), {
    knowledgeId,
    filename: args.filename,
    sourceExt: 'pdf',
    mimeType: 'application/pdf',
    sizeBytes: args.sizeBytes ?? 1024,
    s3Key: `workspaces/${args.workspaceId}/knowledge/${knowledgeId}.pdf`,
    embeddingVersion: 'test:768',
    uploaderId: args.uploaderId
  })
  if (args.status && args.status !== 'processing') {
    const db = testDb()
    await db.query(
      'UPDATE workspace_knowledge SET status = $1 WHERE knowledge_id = $2',
      [args.status, knowledgeId]
    )
  }
  return knowledgeId
}

describe('disambiguateFilename', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns the original filename when not taken', async () => {
    const u = await createUser()
    const ws = await createWorkspace(u.id)
    const picked = await disambiguateFilename(wsAs(ws.workspaceId), 'report.pdf')
    expect(picked).toBe('report.pdf')
  })

  it('appends " (2)" on first collision, preserving extension', async () => {
    const u = await createUser()
    const ws = await createWorkspace(u.id)
    await seed({ workspaceId: ws.workspaceId, uploaderId: u.id, filename: 'report.pdf' })
    const picked = await disambiguateFilename(wsAs(ws.workspaceId), 'report.pdf')
    expect(picked).toBe('report (2).pdf')
  })

  it('keeps climbing the suffix on repeated collisions', async () => {
    const u = await createUser()
    const ws = await createWorkspace(u.id)
    await seed({ workspaceId: ws.workspaceId, uploaderId: u.id, filename: 'report.pdf' })
    await seed({ workspaceId: ws.workspaceId, uploaderId: u.id, filename: 'report (2).pdf' })
    await seed({ workspaceId: ws.workspaceId, uploaderId: u.id, filename: 'report (3).pdf' })
    const picked = await disambiguateFilename(wsAs(ws.workspaceId), 'report.pdf')
    expect(picked).toBe('report (4).pdf')
  })

  it('scopes collisions to the workspace', async () => {
    const u = await createUser()
    const wsA = await createWorkspace(u.id)
    const wsB = await createWorkspace(u.id, { workspaceId: 'ws-other' })
    await seed({ workspaceId: wsA.workspaceId, uploaderId: u.id, filename: 'report.pdf' })
    // Same name allowed in a different workspace.
    const picked = await disambiguateFilename(wsAs(wsB.workspaceId), 'report.pdf')
    expect(picked).toBe('report.pdf')
  })

  it('handles extensionless filenames', async () => {
    const u = await createUser()
    const ws = await createWorkspace(u.id)
    await seed({ workspaceId: ws.workspaceId, uploaderId: u.id, filename: 'README' })
    const picked = await disambiguateFilename(wsAs(ws.workspaceId), 'README')
    expect(picked).toBe('README (2)')
  })
})

describe('aggregate counters', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('count + sum reflect only the given workspace', async () => {
    const u = await createUser()
    const wsA = await createWorkspace(u.id)
    const wsB = await createWorkspace(u.id, { workspaceId: 'ws-aggregates' })
    await seed({ workspaceId: wsA.workspaceId, uploaderId: u.id, filename: 'a.pdf', sizeBytes: 1000 })
    await seed({ workspaceId: wsA.workspaceId, uploaderId: u.id, filename: 'b.pdf', sizeBytes: 2000 })
    await seed({ workspaceId: wsB.workspaceId, uploaderId: u.id, filename: 'c.pdf', sizeBytes: 9999 })
    expect(await countWorkspaceKnowledge(wsAs(wsA.workspaceId))).toBe(2)
    expect(await sumWorkspaceKnowledgeBytes(wsAs(wsA.workspaceId))).toBe(3000)
    expect(await countWorkspaceKnowledge(wsAs(wsB.workspaceId))).toBe(1)
    expect(await sumWorkspaceKnowledgeBytes(wsAs(wsB.workspaceId))).toBe(9999)
  })

  it('returns 0 for an empty workspace', async () => {
    const u = await createUser()
    const ws = await createWorkspace(u.id)
    expect(await countWorkspaceKnowledge(wsAs(ws.workspaceId))).toBe(0)
    expect(await sumWorkspaceKnowledgeBytes(wsAs(ws.workspaceId))).toBe(0)
  })
})

describe('listReadyKnowledgeBrief', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('includes only ready rows', async () => {
    const u = await createUser()
    const ws = await createWorkspace(u.id)
    await seed({ workspaceId: ws.workspaceId, uploaderId: u.id, filename: 'ready.pdf', status: 'ready' })
    await seed({ workspaceId: ws.workspaceId, uploaderId: u.id, filename: 'busy.pdf', status: 'processing' })
    await seed({ workspaceId: ws.workspaceId, uploaderId: u.id, filename: 'broken.pdf', status: 'failed' })
    const brief = await listReadyKnowledgeBrief(wsAs(ws.workspaceId))
    expect(brief.map(b => b.filename).sort()).toEqual(['ready.pdf'])
    // The AI loop decides from this whether a file is someone else's.
    expect(brief[0]?.uploaderId).toBe(u.id)
  })

  it('returns empty for a workspace with no ready rows', async () => {
    const u = await createUser()
    const ws = await createWorkspace(u.id)
    await seed({ workspaceId: ws.workspaceId, uploaderId: u.id, filename: 'pending.pdf', status: 'processing' })
    expect(await listReadyKnowledgeBrief(wsAs(ws.workspaceId))).toEqual([])
  })
})

describe('deleteKnowledgeRow', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('deletes the row (chunks cascade via FK; verified separately)', async () => {
    const u = await createUser()
    const ws = await createWorkspace(u.id)
    const id = await seed({ workspaceId: ws.workspaceId, uploaderId: u.id, filename: 'x.pdf' })
    await deleteKnowledgeRow(wsAs(ws.workspaceId), id)
    expect(await countWorkspaceKnowledge(wsAs(ws.workspaceId))).toBe(0)
  })
})
