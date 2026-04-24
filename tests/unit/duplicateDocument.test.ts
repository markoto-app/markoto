import { describe, it, expect, vi, beforeEach } from 'vitest'

// duplicateDocument is the end-to-end duplicate orchestrator: one DB
// row insert + N S3 CopyObject calls + a Y.js state clone with URL
// rewrite. Ordering is load-bearing (row first so the FK works, then
// S3, then Y.js) and so is the rollback path (if ANY phase after the
// row fails, the row must go away — a half-duplicated doc is worse
// than a clean "duplicate failed" error).
//
// Integration tests exist but run in the dev subprocess and therefore
// don't show up in coverage. These unit tests let us assert the
// ordering + rollback invariants without a DB, and — critically — let
// us force failures at every phase to pin the rollback contract.

const getDoc = vi.fn()
const insertDuplicateDoc = vi.fn()
const deleteDocRow = vi.fn()

const listConfirmedUploadsForDoc = vi.fn()
const insertConfirmedUploads = vi.fn()
const deleteUploadsForDoc = vi.fn()

const cloneYjsStateWithUrlRewrite = vi.fn()

const sentryCaptureException = vi.fn()

vi.mock('../../server/repos/documents', () => ({
  getDoc,
  insertDuplicateDoc,
  deleteDocRow
}))
vi.mock('../../server/repos/uploads', () => ({
  listConfirmedUploadsForDoc,
  insertConfirmedUploads,
  deleteUploadsForDoc
}))
vi.mock('../../server/utils/cloneYjsState', () => ({ cloneYjsStateWithUrlRewrite }))
vi.mock('@sentry/nuxt', () => ({ captureException: sentryCaptureException }))

const { duplicateDocument } = await import('../../server/utils/duplicateDocument')

function fakeSource(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    docId: 'SRC',
    ownerId: 1,
    workspaceId: null,
    title: 'Source',
    accessMode: 'private',
    passwordHash: null,
    theme: { page: { marginMm: 20 } },
    wordCount: 123,
    sizeBytes: 456,
    ...overrides
  }
}

function baseInput(overrides: Partial<Parameters<typeof duplicateDocument>[0]> = {}) {
  return {
    sourceDocId: 'SRC',
    newDocId: 'TGT',
    ownerId: 2,
    workspaceId: null,
    title: 'Source (copy)',
    ...overrides
  }
}

function makeS3() {
  return { send: vi.fn(async () => ({})) }
}

beforeEach(() => {
  getDoc.mockReset()
  insertDuplicateDoc.mockReset()
  deleteDocRow.mockReset()
  listConfirmedUploadsForDoc.mockReset()
  insertConfirmedUploads.mockReset()
  deleteUploadsForDoc.mockReset()
  cloneYjsStateWithUrlRewrite.mockReset()
  sentryCaptureException.mockReset()
})

describe('duplicateDocument — source-not-found', () => {
  it('throws before any write if the source doc is gone', async () => {
    getDoc.mockResolvedValueOnce(null)
    const s3 = makeS3()
    await expect(duplicateDocument(baseInput(), { s3, bucket: 'b' }))
      .rejects.toThrow(/Source document SRC not found/)
    expect(insertDuplicateDoc).not.toHaveBeenCalled()
    expect(s3.send).not.toHaveBeenCalled()
    expect(cloneYjsStateWithUrlRewrite).not.toHaveBeenCalled()
  })
})

describe('duplicateDocument — happy path', () => {
  it('inserts the row, copies each upload to the new prefix, then clones Y.js state', async () => {
    const order: string[] = []
    getDoc.mockResolvedValueOnce(fakeSource())
    insertDuplicateDoc.mockImplementationOnce(async () => { order.push('insertRow') })
    listConfirmedUploadsForDoc.mockResolvedValueOnce([
      { fileId: 'fa', s3Key: 'docs/SRC/fa', uploaderId: 1, contentType: 'image/png', sizeBytes: 100 },
      { fileId: 'fb', s3Key: 'docs/SRC/fb', uploaderId: 1, contentType: 'image/jpeg', sizeBytes: 200 }
    ])
    const s3 = makeS3()
    s3.send.mockImplementation(async () => { order.push('s3copy'); return {} })
    insertConfirmedUploads.mockImplementationOnce(async () => { order.push('insertUploads') })
    cloneYjsStateWithUrlRewrite.mockImplementationOnce(async () => { order.push('cloneYjs') })

    await duplicateDocument(baseInput(), { s3, bucket: 'my-bucket' })

    expect(order).toEqual(['insertRow', 's3copy', 's3copy', 'insertUploads', 'cloneYjs'])
  })

  it('uses the same fileId on both sides so rewritten URLs resolve', async () => {
    // This pins the core URL-rewrite assumption: the fileId segment
    // stays identical, only the docId segment in the S3 key changes.
    getDoc.mockResolvedValueOnce(fakeSource())
    listConfirmedUploadsForDoc.mockResolvedValueOnce([
      { fileId: 'abc123', s3Key: 'docs/SRC/abc123', uploaderId: 1, contentType: 'image/png', sizeBytes: 1 }
    ])
    const s3 = makeS3()
    await duplicateDocument(baseInput(), { s3, bucket: 'b' })

    const copyCmd = s3.send.mock.calls[0]![0] as { input: { CopySource: string, Key: string } }
    expect(copyCmd.input.CopySource).toBe('/b/docs/SRC/abc123')
    expect(copyCmd.input.Key).toBe('docs/TGT/abc123')
  })

  it('skips insertConfirmedUploads entirely when the source has zero images', async () => {
    // Source without any confirmed uploads shouldn't hit the bulk-insert
    // — otherwise we'd be trying to INSERT an empty array (some drivers
    // choke on zero-row inserts, others don't; cheaper to skip).
    getDoc.mockResolvedValueOnce(fakeSource())
    listConfirmedUploadsForDoc.mockResolvedValueOnce([])
    const s3 = makeS3()

    await duplicateDocument(baseInput(), { s3, bucket: 'b' })

    expect(insertConfirmedUploads).not.toHaveBeenCalled()
    expect(s3.send).not.toHaveBeenCalled()
    expect(cloneYjsStateWithUrlRewrite).toHaveBeenCalledOnce()
  })

  it('forwards source accessMode / passwordHash / theme / counters to the row insert', async () => {
    // The duplicate inherits EVERYTHING except ownerId + workspaceId +
    // docId + title. Pinning this here so a future refactor doesn't
    // silently drop (say) the passwordHash and let an anonymous user
    // see a password-protected doc without unlocking.
    getDoc.mockResolvedValueOnce(fakeSource({
      accessMode: 'password-protected',
      passwordHash: 'hashed-pw',
      theme: { page: { marginMm: 25 } },
      wordCount: 500,
      sizeBytes: 10_000
    }))
    listConfirmedUploadsForDoc.mockResolvedValueOnce([])
    const s3 = makeS3()

    await duplicateDocument(baseInput({ ownerId: 7, workspaceId: 'ws1' }), { s3, bucket: 'b' })

    const arg = insertDuplicateDoc.mock.calls[0][0]
    expect(arg).toMatchObject({
      newDocId: 'TGT',
      ownerId: 7,
      workspaceId: 'ws1',
      title: 'Source (copy)',
      accessMode: 'password-protected',
      passwordHash: 'hashed-pw',
      theme: { page: { marginMm: 25 } },
      wordCount: 500,
      sizeBytes: 10_000
    })
  })
})

describe('duplicateDocument — rollback', () => {
  it('rolls back the row when S3 CopyObject throws', async () => {
    // Phase 2 failure: an S3 object was missing (source deleted mid-dup)
    // or S3 is flaky. The partially-created row must go away.
    getDoc.mockResolvedValueOnce(fakeSource())
    listConfirmedUploadsForDoc.mockResolvedValueOnce([
      { fileId: 'fa', s3Key: 'docs/SRC/fa', uploaderId: 1, contentType: 'image/png', sizeBytes: 1 }
    ])
    const s3 = makeS3()
    s3.send.mockRejectedValueOnce(new Error('AccessDenied'))

    await expect(duplicateDocument(baseInput(), { s3, bucket: 'b' })).rejects.toThrow('AccessDenied')

    expect(deleteUploadsForDoc).toHaveBeenCalledWith('TGT')
    expect(deleteDocRow).toHaveBeenCalledWith('TGT')
    expect(cloneYjsStateWithUrlRewrite).not.toHaveBeenCalled()
  })

  it('rolls back the row when the Y.js clone throws', async () => {
    // Phase 3 failure: the source's yjs_documents rows are corrupt /
    // schema drift. S3 copies already happened — leaves orphan objects
    // under `docs/TGT/` that the sweep will clean up.
    getDoc.mockResolvedValueOnce(fakeSource())
    listConfirmedUploadsForDoc.mockResolvedValueOnce([])
    const s3 = makeS3()
    cloneYjsStateWithUrlRewrite.mockRejectedValueOnce(new Error('Y.js replay failed'))

    await expect(duplicateDocument(baseInput(), { s3, bucket: 'b' })).rejects.toThrow('Y.js replay failed')

    expect(deleteUploadsForDoc).toHaveBeenCalledWith('TGT')
    expect(deleteDocRow).toHaveBeenCalledWith('TGT')
  })

  it('swallows rollback failure to Sentry and re-throws the original error', async () => {
    // A rollback failure is bad but the ORIGINAL error is what the
    // caller needs to see (it's the meaningful 500). Surface rollback
    // failures via Sentry so they're still visible to operators.
    getDoc.mockResolvedValueOnce(fakeSource())
    listConfirmedUploadsForDoc.mockResolvedValueOnce([])
    const s3 = makeS3()
    cloneYjsStateWithUrlRewrite.mockRejectedValueOnce(new Error('original failure'))
    deleteUploadsForDoc.mockRejectedValueOnce(new Error('rollback also failed'))

    await expect(duplicateDocument(baseInput(), { s3, bucket: 'b' }))
      .rejects.toThrow('original failure')

    expect(sentryCaptureException).toHaveBeenCalledOnce()
    const [err, opts] = sentryCaptureException.mock.calls[0]!
    expect((err as Error).message).toBe('rollback also failed')
    expect(opts).toMatchObject({
      tags: {
        component: 'duplicateDocument',
        event: 'rollback_failed',
        docId: 'TGT'
      }
    })
  })

  it('does NOT attempt rollback when the insertRow itself fails', async () => {
    // If phase 1 fails there's nothing TO roll back — the FK targets
    // don't exist yet. Trying delete*ForDoc on a non-existent docId
    // would be a pointless DB round-trip.
    getDoc.mockResolvedValueOnce(fakeSource())
    insertDuplicateDoc.mockRejectedValueOnce(new Error('unique constraint'))

    await expect(duplicateDocument(baseInput(), { s3: makeS3(), bucket: 'b' }))
      .rejects.toThrow('unique constraint')

    expect(deleteDocRow).not.toHaveBeenCalled()
    expect(deleteUploadsForDoc).not.toHaveBeenCalled()
  })
})
