import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from '../integration/setup/db'
import { createUser, createWorkspace } from '../integration/setup/fixtures'
import { createKnowledge } from '../../server/repos/knowledge'
import { KNOWLEDGE_ORPHAN_GRACE_MS, sweepKnowledgeOrphans } from '../../server/utils/knowledge/knowledgeOrphanSweep'
import { makeFakeStore } from './fakeObjectStore'
import { wsAs } from '../helpers/access'

// Regression: knowledge originals that were presigned + PUT but never
// confirmed had no DB row, and orphan-cleanup only swept `docs/` — so they
// stayed in the bucket forever, outside every quota.

const HOUR = 60 * 60 * 1000

describe('sweepKnowledgeOrphans', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('deletes old unconfirmed originals and staging leftovers, keeps rows\' originals, fresh uploads and foreign keys', async () => {
    const user = await createUser()
    const ws = await createWorkspace(user.id)
    const store = makeFakeStore()
    const old = new Date(Date.now() - 2 * HOUR)
    const base = `workspaces/${ws.workspaceId}/knowledge`

    const confirmed = `${base}/kConfirmed01.pdf`
    await createKnowledge(wsAs(ws.workspaceId), {
      knowledgeId: 'kConfirmed01',
      filename: 'c.pdf',
      sourceExt: 'pdf',
      mimeType: 'application/pdf',
      sizeBytes: 10,
      s3Key: confirmed,
      embeddingVersion: 'test:768',
      uploaderId: user.id
    })
    store.put(confirmed, old)
    store.put(`${base}/kNeverConf01.pdf`, old)
    store.put(`${base}/staging/kConfirmed01.pdf`, old)
    store.put(`${base}/kInFlight001.pdf`, new Date())
    store.put(`workspaces/${ws.workspaceId}/notes.txt`, old)
    store.put('docs/somedoc1/AAAAAAAAAAAA.png', old)

    const res = await sweepKnowledgeOrphans({ store })

    expect(res.deleted).toBe(2)
    expect(store.has(`${base}/kNeverConf01.pdf`)).toBe(false)
    expect(store.has(`${base}/staging/kConfirmed01.pdf`)).toBe(false)
    expect(store.has(confirmed)).toBe(true)
    expect(store.has(`${base}/kInFlight001.pdf`)).toBe(true)
    expect(store.has(`workspaces/${ws.workspaceId}/notes.txt`)).toBe(true)
    expect(store.has('docs/somedoc1/AAAAAAAAAAAA.png')).toBe(true)
  })

  it('reaps the originals of deleted rows (e.g. a deleted workspace) once past the grace period', async () => {
    const store = makeFakeStore()
    const key = 'workspaces/ws-gone-123/knowledge/kGone0000001.docx'
    store.put(key, new Date())
    expect((await sweepKnowledgeOrphans({ store })).deleted).toBe(0)
    expect((await sweepKnowledgeOrphans({ store, now: Date.now() + KNOWLEDGE_ORPHAN_GRACE_MS + HOUR })).deleted).toBe(1)
    expect(store.has(key)).toBe(false)
  })
})
