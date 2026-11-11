import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DocAuthzRow } from '../../../server/repos/documents'

// Unit tests for requireDocEditAccess — the gate that AI prompt, @ai
// comment trigger, restore, dictation and image upload use to prove a
// logged-in user may write to a doc server-side. Any bug here lets a user
// write to a doc the editor itself would open read-only (or not at all).
//
// The rule is the editor's own Y.js token rule (`decideTokenAccess`
// granting a writable token), so this file pins the whole
// (accessMode × role × ownership) matrix against the doc-row lookup.

vi.stubGlobal('createError', (opts: { statusCode: number, message: string }) =>
  Object.assign(new Error(opts.message), { statusCode: opts.statusCode }))

const getDocWithActorRole = vi.fn<(docId: string, userId: number | null) => Promise<DocAuthzRow | null>>()
vi.mock('../../../server/repos/documents', () => ({ getDocWithActorRole }))

const { requireDocEditAccess } = await import('../../../server/utils/documents/documentAccess')

const ACTOR = 42

function row(overrides: Partial<DocAuthzRow>): DocAuthzRow {
  return {
    ownerId: 1,
    workspaceId: null,
    accessMode: 'private',
    theme: null,
    workspaceRole: null,
    isGuest: false,
    ownerAccessSuspended: false,
    shareExpiresAt: null,
    shareNoDownload: false,
    anonCreatorKeyHash: null,
    title: 'Doc',
    description: '',
    audience: 'technical',
    language: 'en',
    templateId: 'blank',
    ...overrides
  }
}

beforeEach(() => {
  getDocWithActorRole.mockReset()
})

describe('requireDocEditAccess', () => {
  it('throws 404 when the doc does not exist', async () => {
    getDocWithActorRole.mockResolvedValueOnce(null)
    await expect(requireDocEditAccess('missing', ACTOR)).rejects.toMatchObject({
      statusCode: 404,
      message: 'Document not found'
    })
  })

  it('looks the doc up with the caller as actor', async () => {
    getDocWithActorRole.mockResolvedValueOnce(row({ ownerId: ACTOR }))
    await requireDocEditAccess('d1', ACTOR)
    expect(getDocWithActorRole).toHaveBeenCalledWith('d1', ACTOR)
  })

  it.each(['private', 'open-edit', 'open-view', 'password-protected'] as const)(
    'owner can write on a %s doc',
    async (accessMode) => {
      getDocWithActorRole.mockResolvedValueOnce(row({ ownerId: ACTOR, accessMode }))
      await expect(requireDocEditAccess('d1', ACTOR)).resolves.toBeUndefined()
    }
  )

  it.each([
    ['admin', 'private'],
    ['editor', 'private'],
    ['editor', 'open-view'],
    ['editor', 'password-protected'],
    ['admin', 'open-edit']
  ] as const)('workspace %s can write on a %s doc', async (workspaceRole, accessMode) => {
    getDocWithActorRole.mockResolvedValueOnce(row({ workspaceId: 'ws', workspaceRole, accessMode }))
    await expect(requireDocEditAccess('d1', ACTOR)).resolves.toBeUndefined()
  })

  it('a logged-in non-member can write on an open-edit doc (public edit grant)', async () => {
    getDocWithActorRole.mockResolvedValueOnce(row({ accessMode: 'open-edit' }))
    await expect(requireDocEditAccess('d1', ACTOR)).resolves.toBeUndefined()
  })

  it('a workspace VIEWER cannot write on an open-edit doc (viewer wins over the public grant)', async () => {
    getDocWithActorRole.mockResolvedValueOnce(row({ workspaceId: 'ws', workspaceRole: 'viewer', accessMode: 'open-edit' }))
    await expect(requireDocEditAccess('d1', ACTOR)).rejects.toMatchObject({ statusCode: 403 })
  })

  it.each(['private', 'open-view', 'password-protected'] as const)(
    'a workspace viewer cannot write on a %s doc',
    async (accessMode) => {
      getDocWithActorRole.mockResolvedValueOnce(row({ workspaceId: 'ws', workspaceRole: 'viewer', accessMode }))
      await expect(requireDocEditAccess('d1', ACTOR)).rejects.toMatchObject({ statusCode: 403 })
    }
  )

  it.each(['private', 'open-view', 'password-protected'] as const)(
    'a non-member cannot write on a %s doc',
    async (accessMode) => {
      getDocWithActorRole.mockResolvedValueOnce(row({ accessMode }))
      await expect(requireDocEditAccess('d1', ACTOR)).rejects.toMatchObject({
        statusCode: 403,
        message: 'No write access to this document'
      })
    }
  )

  it.each(['private', 'open-view', 'password-protected'] as const)(
    'an owner whose ownership is suspended by single sign-on cannot write on a %s doc',
    async (accessMode) => {
      getDocWithActorRole.mockResolvedValueOnce(row({ ownerId: ACTOR, workspaceId: 'ws', accessMode, ownerAccessSuspended: true }))
      await expect(requireDocEditAccess('d1', ACTOR)).rejects.toMatchObject({ statusCode: 403 })
    }
  )

  it('an owner whose ownership is suspended keeps only the public edit grant of an open-edit doc', async () => {
    getDocWithActorRole.mockResolvedValueOnce(row({ ownerId: ACTOR, workspaceId: 'ws', accessMode: 'open-edit', ownerAccessSuspended: true }))
    await expect(requireDocEditAccess('d1', ACTOR)).resolves.toBeUndefined()
  })
})
