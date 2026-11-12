import { describe, it, expect, vi, beforeEach } from 'vitest'
import { first } from '../../helpers/assert'
import { asUser, docAs, wsAs } from '../../helpers/access'

// duplicateDocument is the end-to-end duplicate orchestrator: one DB
// row insert + N S3 CopyObject calls + a Y.js state clone with URL
// rewrite. Ordering is load-bearing (row first so the FK works, then
// S3, then Y.js) and so is the rollback path (if ANY phase after the
// row fails, the row must go away, a half-duplicated doc is worse
// than a clean "duplicate failed" error).
//
// Integration tests exist but run in the dev subprocess and therefore
// don't show up in coverage. These unit tests let us assert the
// ordering + rollback invariants without a DB, and, critically, let
// us force failures at every phase to pin the rollback contract.

const getDoc = vi.fn()
const insertDuplicateDoc = vi.fn()
const deleteDocRow = vi.fn()

const listConfirmedUploadsForDoc = vi.fn()
const insertConfirmedUploadsWithinQuota = vi.fn()
const insertConfirmedUploads = vi.fn()
const sumImageBytesInScope = vi.fn()
const deleteUploadsForDoc = vi.fn()

// The duplicator's image quota passed in by the callers.
const QUOTA = 1000
const QUOTA_SCOPE = { scope: { kind: 'user' as const, uploaderId: 1, excludePooled: false }, maxBytes: QUOTA, pooled: false }

const cloneYjsStateWithUrlRewrite = vi.fn()

const sentryCaptureException = vi.fn()

vi.mock('../../../server/repos/documents', () => ({
  getDoc,
  insertDuplicateDoc,
  deleteDocRow
}))
vi.mock('../../../server/repos/uploads', () => ({
  listConfirmedUploadsForDoc,
  insertConfirmedUploadsWithinQuota,
  insertConfirmedUploads,
  sumImageBytesInScope,
  deleteUploadsForDoc
}))
vi.mock('../../../server/utils/documents/cloneYjsState', () => ({ cloneYjsStateWithUrlRewrite }))
vi.mock('@sentry/nuxt', () => ({ captureException: sentryCaptureException }))

const { duplicateDocument } = await import('../../../server/utils/documents/duplicateDocument')

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
    source: docAs('SRC'),
    newDocId: 'TGT',
    owner: asUser(2),
    workspace: null,
    title: 'Source (copy)',
    ...overrides
  }
}

function makeS3() {
  return { send: vi.fn<(command: { input: { CopySource: string, Key: string } }) => Promise<object>>(async () => ({})) }
}

beforeEach(() => {
  getDoc.mockReset()
  insertDuplicateDoc.mockReset()
  deleteDocRow.mockReset()
  listConfirmedUploadsForDoc.mockReset()
  listConfirmedUploadsForDoc.mockResolvedValue([])
  insertConfirmedUploadsWithinQuota.mockReset()
  insertConfirmedUploadsWithinQuota.mockResolvedValue({ reserved: true, usedBytes: 0 })
  insertConfirmedUploads.mockReset()
  sumImageBytesInScope.mockReset()
  sumImageBytesInScope.mockResolvedValue(0)
  deleteUploadsForDoc.mockReset()
  cloneYjsStateWithUrlRewrite.mockReset()
  sentryCaptureException.mockReset()
})

describe('duplicateDocument: source-not-found', () => {
  it('throws before any write if the source doc is gone', async () => {
    getDoc.mockResolvedValueOnce(null)
    const s3 = makeS3()
    await expect(duplicateDocument(baseInput(), { s3, bucket: 'b', imageQuota: QUOTA_SCOPE }))
      .rejects.toThrow(/Source document SRC not found/)
    expect(insertDuplicateDoc).not.toHaveBeenCalled()
    expect(s3.send).not.toHaveBeenCalled()
    expect(cloneYjsStateWithUrlRewrite).not.toHaveBeenCalled()
  })
})

describe('duplicateDocument: happy path', () => {
  it('inserts the row, copies each upload to the new prefix, then clones Y.js state', async () => {
    const order: string[] = []
    getDoc.mockResolvedValueOnce(fakeSource())
    insertDuplicateDoc.mockImplementationOnce(async () => {
      order.push('insertRow')
    })
    listConfirmedUploadsForDoc.mockResolvedValueOnce([
      { fileId: 'fa', s3Key: 'docs/SRC/fa', uploaderId: 1, contentType: 'image/png', sizeBytes: 100 },
      { fileId: 'fb', s3Key: 'docs/SRC/fb', uploaderId: 1, contentType: 'image/jpeg', sizeBytes: 200 }
    ])
    const s3 = makeS3()
    s3.send.mockImplementation(async () => {
      order.push('s3copy')
      return {}
    })
    insertConfirmedUploadsWithinQuota.mockImplementationOnce(async () => {
      order.push('insertUploads')
      return { reserved: true, usedBytes: 0 }
    })
    cloneYjsStateWithUrlRewrite.mockImplementationOnce(async () => {
      order.push('cloneYjs')
    })

    await duplicateDocument(baseInput(), { s3, bucket: 'my-bucket', imageQuota: QUOTA_SCOPE })

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
    await duplicateDocument(baseInput(), { s3, bucket: 'b', imageQuota: QUOTA_SCOPE })

    const copyCmd = s3.send.mock.calls[0]![0] as { input: { CopySource: string, Key: string } }
    expect(copyCmd.input.CopySource).toBe('/b/docs/SRC/abc123')
    expect(copyCmd.input.Key).toBe('docs/TGT/abc123')
  })

  it('skips insertConfirmedUploadsWithinQuota entirely when the source has zero images', async () => {
    // Source without any confirmed uploads shouldn't hit the bulk-insert
    // otherwise we'd be trying to INSERT an empty array (some drivers
    // choke on zero-row inserts, others don't; cheaper to skip).
    getDoc.mockResolvedValueOnce(fakeSource())
    listConfirmedUploadsForDoc.mockResolvedValueOnce([])
    const s3 = makeS3()

    await duplicateDocument(baseInput(), { s3, bucket: 'b', imageQuota: QUOTA_SCOPE })

    expect(insertConfirmedUploadsWithinQuota).not.toHaveBeenCalled()
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

    await duplicateDocument(baseInput({ owner: asUser(7), workspace: wsAs('ws1') }), { s3, bucket: 'b', imageQuota: QUOTA_SCOPE })

    const arg = first(insertDuplicateDoc.mock.calls)[1]
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

  it('points custom CSS url()s at the copy\'s uploads', async () => {
    getDoc.mockResolvedValueOnce(fakeSource({
      theme: { page: { marginMm: 25 }, customCss: 'p { background: url(/api/files/SRC/a.png) } q { background: url(/api/files/OTHER/b.png) }' }
    }))
    listConfirmedUploadsForDoc.mockResolvedValueOnce([])
    const s3 = makeS3()

    await duplicateDocument(baseInput(), { s3, bucket: 'b', imageQuota: QUOTA_SCOPE })

    expect(first(insertDuplicateDoc.mock.calls)[1].theme).toEqual({
      page: { marginMm: 25 },
      customCss: 'p { background: url(/api/files/TGT/a.png) } q { background: url(/api/files/OTHER/b.png) }'
    })
  })

  it('points the cover logo and header image at the copy\'s uploads', async () => {
    const { defaultTheme } = await import('../../../shared/utils/theme/defaultTheme')
    getDoc.mockResolvedValueOnce(fakeSource({
      theme: {
        ...defaultTheme,
        brand: { ...defaultTheme.brand, logoUrl: '/api/files/SRC/AbCdEfGhIjKl.png' },
        header: { ...defaultTheme.header, imageUrl: '/api/files/SRC/b.webp' }
      }
    }))
    listConfirmedUploadsForDoc.mockResolvedValueOnce([])

    await duplicateDocument(baseInput(), { s3: makeS3(), bucket: 'b', imageQuota: QUOTA_SCOPE })

    const theme = first(insertDuplicateDoc.mock.calls)[1].theme
    expect(theme.brand.logoUrl).toBe('/api/files/TGT/AbCdEfGhIjKl.png')
    expect(theme.header.imageUrl).toBe('/api/files/TGT/b.webp')
  })
})

describe('duplicateDocument: rollback', () => {
  it('rolls back the row when S3 CopyObject throws', async () => {
    // S3 copy failure: an S3 object was missing (source deleted mid-dup)
    // or S3 is flaky. The partially-created row must go away.
    getDoc.mockResolvedValueOnce(fakeSource())
    listConfirmedUploadsForDoc.mockResolvedValueOnce([
      { fileId: 'fa', s3Key: 'docs/SRC/fa', uploaderId: 1, contentType: 'image/png', sizeBytes: 1 }
    ])
    const s3 = makeS3()
    s3.send.mockRejectedValueOnce(new Error('AccessDenied'))

    await expect(duplicateDocument(baseInput(), { s3, bucket: 'b', imageQuota: QUOTA_SCOPE })).rejects.toThrow('AccessDenied')

    expect(deleteUploadsForDoc).toHaveBeenCalledWith(expect.objectContaining({ docId: 'TGT' }))
    expect(deleteDocRow).toHaveBeenCalledWith(expect.objectContaining({ docId: 'TGT' }))
    expect(cloneYjsStateWithUrlRewrite).not.toHaveBeenCalled()
  })

  it('rolls back the row when the Y.js clone throws', async () => {
    // Y.js clone failure: the source's yjs_updates rows are corrupt /
    // schema drift. S3 copies already happened, leaves orphan objects
    // under `docs/TGT/` that the sweep will clean up.
    getDoc.mockResolvedValueOnce(fakeSource())
    listConfirmedUploadsForDoc.mockResolvedValueOnce([])
    const s3 = makeS3()
    cloneYjsStateWithUrlRewrite.mockRejectedValueOnce(new Error('Y.js replay failed'))

    await expect(duplicateDocument(baseInput(), { s3, bucket: 'b', imageQuota: QUOTA_SCOPE })).rejects.toThrow('Y.js replay failed')

    expect(deleteUploadsForDoc).toHaveBeenCalledWith(expect.objectContaining({ docId: 'TGT' }))
    expect(deleteDocRow).toHaveBeenCalledWith(expect.objectContaining({ docId: 'TGT' }))
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

    await expect(duplicateDocument(baseInput(), { s3, bucket: 'b', imageQuota: QUOTA_SCOPE }))
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
    // If phase 1 fails there's nothing TO roll back, the FK targets
    // don't exist yet. Trying delete*ForDoc on a non-existent docId
    // would be a pointless DB round-trip.
    getDoc.mockResolvedValueOnce(fakeSource())
    insertDuplicateDoc.mockRejectedValueOnce(new Error('unique constraint'))

    await expect(duplicateDocument(baseInput(), { s3: makeS3(), bucket: 'b', imageQuota: QUOTA_SCOPE }))
      .rejects.toThrow('unique constraint')

    expect(deleteDocRow).not.toHaveBeenCalled()
    expect(deleteUploadsForDoc).not.toHaveBeenCalled()
  })

  it('rolls back uploads BEFORE the doc row (FK-safe ordering)', async () => {
    // `uploads.doc_id` has `ON DELETE CASCADE` today, so in practice
    // deleting the row first would also wipe the uploads. The SUT
    // nevertheless deletes uploads FIRST explicitly. Pin that ordering
    // so a future refactor that drops the CASCADE doesn't silently
    // create FK-violation errors on rollback (the row-delete would
    // then leave dangling uploads).
    const order: string[] = []
    getDoc.mockResolvedValueOnce(fakeSource())
    listConfirmedUploadsForDoc.mockResolvedValueOnce([])
    deleteUploadsForDoc.mockImplementationOnce(async () => {
      order.push('uploads')
    })
    deleteDocRow.mockImplementationOnce(async () => {
      order.push('row')
    })
    cloneYjsStateWithUrlRewrite.mockRejectedValueOnce(new Error('force rollback'))

    await expect(duplicateDocument(baseInput(), { s3: makeS3(), bucket: 'b', imageQuota: QUOTA_SCOPE }))
      .rejects.toThrow('force rollback')

    expect(order).toEqual(['uploads', 'row'])
  })
})

describe('duplicateDocument: image storage quota', () => {
  const images = [
    { fileId: 'fa', s3Key: 'docs/SRC/fa', uploaderId: 1, contentType: 'image/png', sizeBytes: 300 },
    { fileId: 'fb', s3Key: 'docs/SRC/fb', uploaderId: 1, contentType: 'image/png', sizeBytes: 400 }
  ]

  // Regression: copies kept the ORIGINAL uploader, so anyone able to edit
  // an open doc could fill its author's quota (and storage was unbounded).
  it('attributes the copies to the duplicator and inserts them within their quota', async () => {
    getDoc.mockResolvedValueOnce(fakeSource())
    listConfirmedUploadsForDoc.mockResolvedValueOnce(images)

    await duplicateDocument(baseInput({ owner: asUser(2) }), { s3: makeS3(), bucket: 'b', imageQuota: QUOTA_SCOPE })

    expect(insertConfirmedUploadsWithinQuota).toHaveBeenCalledOnce()
    const [, rows, maxBytes, scope] = insertConfirmedUploadsWithinQuota.mock.calls[0]!
    expect(maxBytes).toBe(QUOTA)
    expect(scope).toEqual(QUOTA_SCOPE.scope)
    expect((rows as Array<{ uploaderId: number }>).map(r => r.uploaderId)).toEqual([2, 2])
  })

  it('refuses before writing or copying anything when the copies would not fit', async () => {
    getDoc.mockResolvedValueOnce(fakeSource())
    listConfirmedUploadsForDoc.mockResolvedValueOnce(images)
    sumImageBytesInScope.mockResolvedValueOnce(QUOTA - 500) // 700 more would exceed it
    const s3 = makeS3()

    await expect(duplicateDocument(baseInput(), { s3, bucket: 'b', imageQuota: QUOTA_SCOPE }))
      .rejects.toThrow(/image storage limit/)
    expect(insertDuplicateDoc).not.toHaveBeenCalled()
    expect(s3.send).not.toHaveBeenCalled()
  })

  it('rolls back when the atomic insert finds the quota exhausted', async () => {
    getDoc.mockResolvedValueOnce(fakeSource())
    listConfirmedUploadsForDoc.mockResolvedValueOnce(images)
    insertConfirmedUploadsWithinQuota.mockResolvedValueOnce({ reserved: false, usedBytes: QUOTA })

    await expect(duplicateDocument(baseInput(), { s3: makeS3(), bucket: 'b', imageQuota: QUOTA_SCOPE }))
      .rejects.toThrow(/image storage limit/)
    expect(deleteUploadsForDoc).toHaveBeenCalledWith(expect.objectContaining({ docId: 'TGT' }))
    expect(deleteDocRow).toHaveBeenCalledWith(expect.objectContaining({ docId: 'TGT' }))
    expect(cloneYjsStateWithUrlRewrite).not.toHaveBeenCalled()
  })
})
