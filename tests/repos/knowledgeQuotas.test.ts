import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import {
  countKnowledgeByUploader,
  sumKnowledgeBytesByUploader,
  createKnowledge
} from '../../server/repos/knowledge'
import { countOwnedWorkspacesByUser } from '../../server/repos/workspaces'
import { createUser, createWorkspace } from '../integration/setup/fixtures'

// Per-user quota aggregators. Cheap repo-level checks so the
// endpoint-level cap logic has solid primitives.

async function seed(args: {
  workspaceId: string
  uploaderId: number
  filename: string
  sizeBytes?: number
}): Promise<void> {
  const kid = `kn-${Math.random().toString(36).slice(2, 10)}`
  await createKnowledge({
    knowledgeId: kid,
    workspaceId: args.workspaceId,
    filename: args.filename,
    sourceExt: 'pdf',
    mimeType: 'application/pdf',
    sizeBytes: args.sizeBytes ?? 1024,
    s3Key: `workspaces/${args.workspaceId}/knowledge/${kid}.pdf`,
    embeddingVersion: 'test:768',
    uploaderId: args.uploaderId
  })
}

describe('countKnowledgeByUploader / sumKnowledgeBytesByUploader', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('counts and sums ONLY the uploader\'s rows, across workspaces', async () => {
    const u1 = await createUser()
    const u2 = await createUser()
    const wsA = await createWorkspace(u1.id)
    const wsB = await createWorkspace(u1.id, { workspaceId: 'ws-user-fanout' })

    // u1 uploads to two workspaces; u2 uploads to one of them.
    await seed({ workspaceId: wsA.workspaceId, uploaderId: u1.id, filename: 'a.pdf', sizeBytes: 1000 })
    await seed({ workspaceId: wsA.workspaceId, uploaderId: u1.id, filename: 'b.pdf', sizeBytes: 2000 })
    await seed({ workspaceId: wsB.workspaceId, uploaderId: u1.id, filename: 'c.pdf', sizeBytes: 500 })
    await seed({ workspaceId: wsA.workspaceId, uploaderId: u2.id, filename: 'x.pdf', sizeBytes: 9999 })

    expect(await countKnowledgeByUploader(u1.id)).toBe(3)
    expect(await sumKnowledgeBytesByUploader(u1.id)).toBe(3500)
    expect(await countKnowledgeByUploader(u2.id)).toBe(1)
    expect(await sumKnowledgeBytesByUploader(u2.id)).toBe(9999)
  })

  it('counts rows regardless of status', async () => {
    const u = await createUser()
    const ws = await createWorkspace(u.id)
    await seed({ workspaceId: ws.workspaceId, uploaderId: u.id, filename: 'ok.pdf', sizeBytes: 1000 })
    await seed({ workspaceId: ws.workspaceId, uploaderId: u.id, filename: 'bad.pdf', sizeBytes: 2000 })
    // Flip one to failed — it should STILL count against the quota.
    const db = testDb()
    await db.query(`UPDATE workspace_knowledge SET status = 'failed' WHERE filename = 'bad.pdf'`)
    expect(await countKnowledgeByUploader(u.id)).toBe(2)
    expect(await sumKnowledgeBytesByUploader(u.id)).toBe(3000)
  })

  it('returns zero for a user with no uploads', async () => {
    const u = await createUser()
    expect(await countKnowledgeByUploader(u.id)).toBe(0)
    expect(await sumKnowledgeBytesByUploader(u.id)).toBe(0)
  })
})

describe('countOwnedWorkspacesByUser', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('counts only workspaces the user created', async () => {
    const creator = await createUser()
    const other = await createUser()
    await createWorkspace(creator.id)
    await createWorkspace(creator.id, { workspaceId: 'ws-two' })
    await createWorkspace(other.id, { workspaceId: 'ws-other' })
    // Membership in someone else's workspace doesn't count.
    const db = testDb()
    await db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-other', $1, 'editor')`,
      [creator.id]
    )

    expect(await countOwnedWorkspacesByUser(creator.id)).toBe(2)
    expect(await countOwnedWorkspacesByUser(other.id)).toBe(1)
  })
})
