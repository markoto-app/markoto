import { describe, it, expect, vi, beforeEach } from 'vitest'

import { wsAs } from '../../helpers/access'

// Unit tests for the deleteKnowledgeArtifact cascade. The role rules (view:
// member, upload: admin / editor, delete: admin or the editor who uploaded) are
// declared by the routes and covered by the workspaceKnowledge integration test.

const getKnowledge = vi.fn<(id: string) => Promise<{ s3Key: string } | null>>()
const deleteKnowledgeRow = vi.fn<(id: string) => Promise<void>>()

vi.mock('../../../server/repos/knowledge', () => ({ getKnowledge, deleteKnowledgeRow }))

const s3Send = vi.fn(async () => {})
vi.stubGlobal('useS3Client', () => ({ send: s3Send }))

// Sentry: no-op at runtime, but capture calls for one assertion about
// the S3-failure path (the artifact delete must Sentry-tag the failure).
const sentryCaptureException = vi.fn()
vi.mock('@sentry/nuxt', () => ({ captureException: sentryCaptureException }))
const { deleteKnowledgeArtifact } = await import('../../../server/utils/knowledge/knowledgeAccess')

beforeEach(() => {
  getKnowledge.mockReset()
  deleteKnowledgeRow.mockReset()
  s3Send.mockReset()
  s3Send.mockImplementation(async () => {})
  sentryCaptureException.mockReset()
})

describe('deleteKnowledgeArtifact', () => {
  it('is a no-op if the row is gone (idempotent delete)', async () => {
    getKnowledge.mockResolvedValueOnce(null)
    await deleteKnowledgeArtifact(wsAs('ws-1'), 'k1')
    expect(deleteKnowledgeRow).not.toHaveBeenCalled()
    expect(s3Send).not.toHaveBeenCalled()
  })

  it('deletes DB row first, then S3 object (ordering invariant)', async () => {
    // DB before S3 so the user sees the file "disappear" immediately.
    // An S3 failure afterwards leaves an orphan object — acceptable,
    // logged + Sentry'd.
    const order: string[] = []
    getKnowledge.mockResolvedValueOnce({ s3Key: 'some/key' })
    deleteKnowledgeRow.mockImplementationOnce(async () => {
      order.push('db')
    })
    s3Send.mockImplementationOnce(async () => {
      order.push('s3')
    })
    await deleteKnowledgeArtifact(wsAs('ws-1'), 'k1')
    expect(order).toEqual(['db', 's3'])
  })

  it('swallows S3 errors and routes to Sentry (DB delete already succeeded)', async () => {
    getKnowledge.mockResolvedValueOnce({ s3Key: 'some/key' })
    s3Send.mockImplementationOnce(async () => {
      throw new Error('S3 down')
    })
    // Must NOT throw — the row is already gone, the user already saw success.
    await expect(deleteKnowledgeArtifact(wsAs('ws-1'), 'k1')).resolves.toBeUndefined()
    expect(sentryCaptureException).toHaveBeenCalledOnce()
    const call = sentryCaptureException.mock.calls[0]!
    expect(call[1]).toMatchObject({
      tags: expect.objectContaining({
        component: 'knowledgeAccess',
        event: 's3_delete_failed',
        knowledgeId: 'k1'
      })
    })
  })

  it('propagates DB-delete errors (don\'t silently orphan S3)', async () => {
    // If we can't remove the row we MUST NOT delete the S3 object —
    // the user would see the file still in the list (row visible) and
    // then 404 when trying to re-reference it (S3 gone). Propagate.
    getKnowledge.mockResolvedValueOnce({ s3Key: 'some/key' })
    deleteKnowledgeRow.mockRejectedValueOnce(new Error('DB down'))
    await expect(deleteKnowledgeArtifact(wsAs('ws-1'), 'k1')).rejects.toThrow('DB down')
    expect(s3Send).not.toHaveBeenCalled()
  })
})
