import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { H3Event } from 'h3'

// Unit tests for the three knowledge-base authz gates plus the
// deleteKnowledgeArtifact cascade. Role matrix:
//
//                      | view | edit | delete
//   ──────────────────────────────────────────
//   non-member         | 404  | 404  | 404
//   viewer             | OK   | 403  | 403
//   editor             | OK   | OK   | own only
//   admin              | OK   | OK   | OK
//
// Missing-workspace returns 404 (not 403) so we don't leak which IDs
// exist to callers who aren't members — important because workspace IDs
// are nanoid-style but members might enumerate from an external system.

const getMemberRole = vi.fn<(wsId: string, userId: number) => Promise<'admin' | 'editor' | 'viewer' | null>>()
const getKnowledge = vi.fn<(id: string) => Promise<{ s3Key: string } | null>>()
const deleteKnowledgeRow = vi.fn<(id: string) => Promise<void>>()

vi.mock('../../../server/repos/workspaceMembers', () => ({ getMemberRole }))
vi.mock('../../../server/repos/knowledge', () => ({ getKnowledge, deleteKnowledgeRow }))

const s3Send = vi.fn(async () => {})
vi.stubGlobal('useS3Client', () => ({ send: s3Send }))
vi.stubGlobal('useRuntimeConfig', () => ({ s3: { bucket: 'test-bucket' } }))
vi.stubGlobal('createError', (opts: { statusCode: number, message: string }) => {
  const err = new Error(opts.message) as Error & { statusCode: number }
  err.statusCode = opts.statusCode
  return err
})

// Sentry: no-op at runtime, but capture calls for one assertion about
// the S3-failure path (the artifact delete must Sentry-tag the failure).
const sentryCaptureException = vi.fn()
vi.mock('@sentry/nuxt', () => ({ captureException: sentryCaptureException }))

const {
  requireKnowledgeViewAccess,
  requireKnowledgeEditAccess,
  requireKnowledgeDeleteAccess,
  deleteKnowledgeArtifact
} = await import('../../../server/utils/knowledge/knowledgeAccess')

function fakeEvent(): H3Event {
  return {} as H3Event
}

beforeEach(() => {
  getMemberRole.mockReset()
  getKnowledge.mockReset()
  deleteKnowledgeRow.mockReset()
  s3Send.mockReset()
  s3Send.mockImplementation(async () => {})
  sentryCaptureException.mockReset()
})

describe('requireKnowledgeViewAccess', () => {
  it('throws 404 for non-members (does not leak workspace existence)', async () => {
    getMemberRole.mockResolvedValueOnce(null)
    await expect(requireKnowledgeViewAccess(fakeEvent(), 'w1', 42))
      .rejects.toMatchObject({ statusCode: 404 })
  })

  it('returns the role for viewer', async () => {
    getMemberRole.mockResolvedValueOnce('viewer')
    expect(await requireKnowledgeViewAccess(fakeEvent(), 'w1', 42)).toBe('viewer')
  })

  it('returns the role for editor', async () => {
    getMemberRole.mockResolvedValueOnce('editor')
    expect(await requireKnowledgeViewAccess(fakeEvent(), 'w1', 42)).toBe('editor')
  })

  it('returns the role for admin', async () => {
    getMemberRole.mockResolvedValueOnce('admin')
    expect(await requireKnowledgeViewAccess(fakeEvent(), 'w1', 42)).toBe('admin')
  })
})

describe('requireKnowledgeEditAccess', () => {
  it('throws 404 for non-members (inherits from view)', async () => {
    getMemberRole.mockResolvedValueOnce(null)
    await expect(requireKnowledgeEditAccess(fakeEvent(), 'w1', 42))
      .rejects.toMatchObject({ statusCode: 404 })
  })

  it('throws 403 for viewer (members-but-read-only)', async () => {
    getMemberRole.mockResolvedValueOnce('viewer')
    await expect(requireKnowledgeEditAccess(fakeEvent(), 'w1', 42))
      .rejects.toMatchObject({ statusCode: 403 })
  })

  it('allows editor', async () => {
    getMemberRole.mockResolvedValueOnce('editor')
    expect(await requireKnowledgeEditAccess(fakeEvent(), 'w1', 42)).toBe('editor')
  })

  it('allows admin', async () => {
    getMemberRole.mockResolvedValueOnce('admin')
    expect(await requireKnowledgeEditAccess(fakeEvent(), 'w1', 42)).toBe('admin')
  })
})

describe('requireKnowledgeDeleteAccess', () => {
  it('throws 404 for non-members (inherits from view/edit)', async () => {
    getMemberRole.mockResolvedValueOnce(null)
    await expect(requireKnowledgeDeleteAccess(fakeEvent(), 'w1', 42, 42))
      .rejects.toMatchObject({ statusCode: 404 })
  })

  it('throws 403 for viewer (inherits from edit)', async () => {
    getMemberRole.mockResolvedValueOnce('viewer')
    await expect(requireKnowledgeDeleteAccess(fakeEvent(), 'w1', 42, 42))
      .rejects.toMatchObject({ statusCode: 403 })
  })

  it('admin can delete any upload', async () => {
    getMemberRole.mockResolvedValueOnce('admin')
    expect(await requireKnowledgeDeleteAccess(fakeEvent(), 'w1', 42, 999)).toBe('admin')
  })

  it('admin can delete anonymous/NULL-uploader uploads', async () => {
    // Without this we'd leave orphan rows uncleanable once an editor
    // who uploaded them leaves the workspace and their uploader FK nulls.
    getMemberRole.mockResolvedValueOnce('admin')
    expect(await requireKnowledgeDeleteAccess(fakeEvent(), 'w1', 42, null)).toBe('admin')
  })

  it('editor can delete their own uploads', async () => {
    getMemberRole.mockResolvedValueOnce('editor')
    expect(await requireKnowledgeDeleteAccess(fakeEvent(), 'w1', 42, 42)).toBe('editor')
  })

  it('editor CANNOT delete another member\'s upload', async () => {
    // Core authz rule: editors curate together but can't clobber each
    // other's work. Only admins have the blanket-delete right.
    getMemberRole.mockResolvedValueOnce('editor')
    await expect(requireKnowledgeDeleteAccess(fakeEvent(), 'w1', 42, 99))
      .rejects.toMatchObject({ statusCode: 403 })
  })

  it('editor CANNOT delete anonymous-uploader rows (only admin)', async () => {
    getMemberRole.mockResolvedValueOnce('editor')
    await expect(requireKnowledgeDeleteAccess(fakeEvent(), 'w1', 42, null))
      .rejects.toMatchObject({ statusCode: 403 })
  })
})

describe('deleteKnowledgeArtifact', () => {
  it('is a no-op if the row is gone (idempotent delete)', async () => {
    getKnowledge.mockResolvedValueOnce(null)
    await deleteKnowledgeArtifact('k1')
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
    await deleteKnowledgeArtifact('k1')
    expect(order).toEqual(['db', 's3'])
  })

  it('swallows S3 errors and routes to Sentry (DB delete already succeeded)', async () => {
    getKnowledge.mockResolvedValueOnce({ s3Key: 'some/key' })
    s3Send.mockImplementationOnce(async () => {
      throw new Error('S3 down')
    })
    // Must NOT throw — the row is already gone, the user already saw success.
    await expect(deleteKnowledgeArtifact('k1')).resolves.toBeUndefined()
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
    await expect(deleteKnowledgeArtifact('k1')).rejects.toThrow('DB down')
    expect(s3Send).not.toHaveBeenCalled()
  })
})
