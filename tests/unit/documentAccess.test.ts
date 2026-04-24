import { describe, it, expect, vi, beforeEach } from 'vitest'

// Unit tests for requireDocEditAccess — the single gate that AI endpoints
// use to prove an authenticated user may write to a doc. Any bug here
// lets a logged-in user steer AI tools against ANY doc by id.
//
// We stub three things at the module boundary:
//   1. useDatabase() — return a promise that resolves to the doc row.
//   2. canEditDoc() — already covered by workspaceAccess.test.ts; here
//      it's a yes/no boolean and we drive both branches.
//   3. createError — auto-imported by the SUT; vitest handles the
//      undefined global via a local stub.
const mockRow = vi.fn<() => Promise<{ accessMode: string, ownerId: number | null } | undefined>>()

const dbChain = {
  select: () => dbChain,
  from: () => dbChain,
  where: () => dbChain,
  limit: async () => {
    const r = await mockRow()
    return r ? [r] : []
  }
}

vi.stubGlobal('useDatabase', () => dbChain)
vi.stubGlobal('createError', (opts: { statusCode: number, message: string }) => {
  const err = new Error(opts.message) as Error & { statusCode: number }
  err.statusCode = opts.statusCode
  return err
})

const canEditDoc = vi.fn<(userId: number, docId: string) => Promise<boolean>>()
vi.stubGlobal('canEditDoc', canEditDoc)

// Also expose as a mocked module for any ambient import.
vi.mock('../../server/utils/workspaceAccess', () => ({ canEditDoc }))

const { requireDocEditAccess } = await import('../../server/utils/documentAccess')

beforeEach(() => {
  mockRow.mockReset()
  canEditDoc.mockReset()
})

describe('requireDocEditAccess', () => {
  it('throws 404 when the doc does not exist', async () => {
    mockRow.mockResolvedValueOnce(undefined)
    await expect(requireDocEditAccess('missing', 42)).rejects.toMatchObject({
      statusCode: 404,
      message: 'Document not found'
    })
    // canEditDoc should never be queried for a non-existent doc.
    expect(canEditDoc).not.toHaveBeenCalled()
  })

  it('resolves when canEditDoc returns true (owner / admin / editor)', async () => {
    mockRow.mockResolvedValueOnce({ accessMode: 'private', ownerId: 1 })
    canEditDoc.mockResolvedValueOnce(true)
    await expect(requireDocEditAccess('d1', 42)).resolves.toBeUndefined()
  })

  it('resolves when accessMode=open-edit even if canEditDoc is false', async () => {
    // Anonymous / open docs: anyone with the link can edit. AI endpoints
    // need the same posture so a logged-in passer-by can use AI on a
    // public scratch doc.
    mockRow.mockResolvedValueOnce({ accessMode: 'open-edit', ownerId: null })
    canEditDoc.mockResolvedValueOnce(false)
    await expect(requireDocEditAccess('d1', 42)).resolves.toBeUndefined()
  })

  it('throws 403 on private doc when canEditDoc returns false', async () => {
    mockRow.mockResolvedValueOnce({ accessMode: 'private', ownerId: 1 })
    canEditDoc.mockResolvedValueOnce(false)
    await expect(requireDocEditAccess('d1', 42)).rejects.toMatchObject({
      statusCode: 403,
      message: 'No write access to this document'
    })
  })

  it('throws 403 on open-view when canEditDoc returns false (view-only blocks AI writes)', async () => {
    // open-view lets anyone SEE the doc but not edit it. AI writes must
    // still be refused for non-owners; the accessMode fallback is
    // scoped to open-edit only.
    mockRow.mockResolvedValueOnce({ accessMode: 'open-view', ownerId: 1 })
    canEditDoc.mockResolvedValueOnce(false)
    await expect(requireDocEditAccess('d1', 42)).rejects.toMatchObject({
      statusCode: 403
    })
  })

  it('throws 403 on password-protected doc when canEditDoc returns false', async () => {
    // Password-protected access lives behind the token endpoint, not
    // accessMode. AI endpoints mint their own server-side JWT and must
    // not treat password-gated docs as writable without membership.
    mockRow.mockResolvedValueOnce({ accessMode: 'password-protected', ownerId: 1 })
    canEditDoc.mockResolvedValueOnce(false)
    await expect(requireDocEditAccess('d1', 42)).rejects.toMatchObject({
      statusCode: 403
    })
  })
})
