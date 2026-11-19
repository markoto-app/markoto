import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import { createDoc, createUser, createWorkspace, setMemberRole } from '../integration/setup/fixtures'
import { createFolder } from '../../server/repos/folders'
import { upsertDocumentSearch } from '../../server/repos/documentSearch'
import { createImportJob } from '../../server/repos/imports'
import { __mintWorkspaceAccess, __userActor } from '../../server/repos/proofs/testing'
import { asUser, docAs } from '../helpers/access'

// Account deletion and document deletion reach the explorer's tables:
// personal folders and import records go with the account (FK cascade on
// the user), workspace folders with the workspace, the search copy of a
// document with the document. The explorer triggers fire during those
// cascades and must not break them.

vi.mock('../../server/utils/documents/documentLifecycle', () => ({
  deleteDocument: vi.fn(async () => {})
}))
vi.mock('../../server/utils/knowledge/knowledgeAccess', () => ({
  deleteKnowledgeArtifact: vi.fn(async () => {})
}))
vi.mock('../../server/utils/billing/stripeClient', () => ({
  useStripeClient: () => ({ customers: { del: vi.fn(async () => ({ id: 'cus_x', deleted: true })) } })
}))

const { executeAccountDeletion } = await import('../../server/utils/privacy/accountDeletionExecute')

async function count(sql: string, params: unknown[]): Promise<number> {
  return Number((await testDb().query<{ n: string }>(sql, params)).rows[0]?.n)
}

describe('account deletion and the explorer tables', () => {
  beforeEach(resetDb)

  it('removes personal folders, sole-member workspace folders and import records; keeps others\' folders', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const solo = await createWorkspace(alice.id)
    const shared = await createWorkspace(bob.id)
    await setMemberRole(shared.workspaceId, alice.id, 'editor')

    await createFolder(asUser(alice.id), { folderId: 'alice-personal', name: 'Mine', parentId: null })
    await createFolder(asUser(alice.id), { folderId: 'alice-sub', name: 'Sub', parentId: 'alice-personal' })
    await createFolder(__mintWorkspaceAccess(__userActor(alice.id), solo.workspaceId, 'admin', 'editor'), { folderId: 'solo-f', name: 'Solo', parentId: null })
    await createFolder(__mintWorkspaceAccess(__userActor(alice.id), shared.workspaceId, 'editor', 'editor'), { folderId: 'shared-f', name: 'Shared', parentId: null })
    await createImportJob(asUser(alice.id), {
      jobId: 'job-alice',
      workspaceId: null,
      targetFolderId: 'alice-personal',
      source: 'github',
      sourceRef: 'https://github.com/o/r',
      status: 'queued',
      total: 1,
      skipped: 0,
      totalBytes: 0,
      items: [{ itemId: 'i1', relativePath: 'a.md', kind: 'doc', s3Key: null, sizeBytes: 3 }]
    })

    await executeAccountDeletion({ userId: alice.id })

    expect(await count('SELECT count(*) AS n FROM folders WHERE owner_id = $1', [alice.id])).toBe(0)
    expect(await count('SELECT count(*) AS n FROM folders WHERE workspace_id = $1', [solo.workspaceId])).toBe(0)
    expect(await count('SELECT count(*) AS n FROM import_jobs', [])).toBe(0)
    expect(await count('SELECT count(*) AS n FROM import_job_items', [])).toBe(0)
    const kept = await testDb().query<{ created_by: number | null }>('SELECT created_by FROM folders WHERE folder_id = $1', ['shared-f'])
    expect(kept.rows).toEqual([{ created_by: null }])
  })

  it('removes a document\'s search copy with the document', async () => {
    const alice = await createUser()
    const doc = await createDoc({ ownerId: alice.id })
    await upsertDocumentSearch(docAs(doc.docId), { title: 'T', body: 'hello world', yjsId: 1, wordCount: 2, sizeBytes: 11 })
    expect(await count('SELECT count(*) AS n FROM document_search WHERE doc_id = $1', [doc.docId])).toBe(1)
    await testDb().query('DELETE FROM documents WHERE doc_id = $1', [doc.docId])
    expect(await count('SELECT count(*) AS n FROM document_search WHERE doc_id = $1', [doc.docId])).toBe(0)
  })

  it('a workspace delete takes its folders along', async () => {
    const alice = await createUser()
    const ws = await createWorkspace(alice.id)
    const scope = __mintWorkspaceAccess(__userActor(alice.id), ws.workspaceId, 'admin', 'editor')
    await createFolder(scope, { folderId: 'p', name: 'P', parentId: null })
    await createFolder(scope, { folderId: 'c', name: 'C', parentId: 'p' })
    await testDb().query('DELETE FROM workspaces WHERE workspace_id = $1', [ws.workspaceId])
    expect(await count('SELECT count(*) AS n FROM folders', [])).toBe(0)
  })
})
