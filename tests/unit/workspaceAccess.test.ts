import { describe, it, expect, vi, beforeEach } from 'vitest'

// Authz shortcut unit tests. workspaceAccess.ts delegates to two repo
// functions (`getDocWithActorRole`, `getMemberRole`); stub both at the
// module boundary so we can drive every branch deterministically with
// no DB. The integration suite already exercises the SQL paths; this
// suite owns the role-matrix logic.
const getDocWithActorRole = vi.fn()
const getMemberRole = vi.fn()

vi.mock('../../server/repos/documents', () => ({ getDocWithActorRole }))
vi.mock('../../server/repos/workspaceMembers', () => ({ getMemberRole }))

const {
  canEditDoc,
  canManageDoc,
  canManageWorkspace,
  getWorkspaceRole,
  getDocAuthz
} = await import('../../server/utils/workspaceAccess')

type Ctx = Awaited<ReturnType<typeof getDocWithActorRole>>

function ctx(overrides: Partial<NonNullable<Ctx>> = {}): NonNullable<Ctx> {
  return {
    ownerId: 1,
    workspaceId: null,
    accessMode: 'private',
    theme: null,
    workspaceRole: null,
    workspaceAiEnabled: false,
    billingOwner: null,
    ...overrides
  } as NonNullable<Ctx>
}

beforeEach(() => {
  getDocWithActorRole.mockReset()
  getMemberRole.mockReset()
})

describe('canEditDoc', () => {
  it('returns false when the doc does not exist', async () => {
    getDocWithActorRole.mockResolvedValueOnce(null)
    expect(await canEditDoc(42, 'missing')).toBe(false)
  })

  it('owner can always edit (standalone doc)', async () => {
    getDocWithActorRole.mockResolvedValueOnce(ctx({ ownerId: 42, workspaceId: null, workspaceRole: null }))
    expect(await canEditDoc(42, 'd1')).toBe(true)
  })

  it('workspace admin can edit', async () => {
    getDocWithActorRole.mockResolvedValueOnce(ctx({ ownerId: 1, workspaceId: 'w1', workspaceRole: 'admin' }))
    expect(await canEditDoc(42, 'd1')).toBe(true)
  })

  it('workspace editor can edit', async () => {
    getDocWithActorRole.mockResolvedValueOnce(ctx({ ownerId: 1, workspaceId: 'w1', workspaceRole: 'editor' }))
    expect(await canEditDoc(42, 'd1')).toBe(true)
  })

  it('viewer CANNOT edit', async () => {
    getDocWithActorRole.mockResolvedValueOnce(ctx({ ownerId: 1, workspaceId: 'w1', workspaceRole: 'viewer' }))
    expect(await canEditDoc(42, 'd1')).toBe(false)
  })

  it('non-member on a workspace doc CANNOT edit', async () => {
    getDocWithActorRole.mockResolvedValueOnce(ctx({ ownerId: 1, workspaceId: 'w1', workspaceRole: null }))
    expect(await canEditDoc(42, 'd1')).toBe(false)
  })
})

describe('canManageDoc', () => {
  it('returns false when the doc does not exist', async () => {
    getDocWithActorRole.mockResolvedValueOnce(null)
    expect(await canManageDoc(42, 'missing')).toBe(false)
  })

  it('owner can manage', async () => {
    getDocWithActorRole.mockResolvedValueOnce(ctx({ ownerId: 42, workspaceRole: null }))
    expect(await canManageDoc(42, 'd1')).toBe(true)
  })

  it('admin can manage', async () => {
    getDocWithActorRole.mockResolvedValueOnce(ctx({ ownerId: 1, workspaceId: 'w1', workspaceRole: 'admin' }))
    expect(await canManageDoc(42, 'd1')).toBe(true)
  })

  it('editor CANNOT manage (sharing/delete is admin-only)', async () => {
    // This is the deliberate split: canEdit → true, canManage → false.
    // Editors can edit content but not change access mode, password,
    // or delete docs they didn't create.
    getDocWithActorRole.mockResolvedValueOnce(ctx({ ownerId: 1, workspaceId: 'w1', workspaceRole: 'editor' }))
    expect(await canManageDoc(42, 'd1')).toBe(false)
  })

  it('viewer CANNOT manage', async () => {
    getDocWithActorRole.mockResolvedValueOnce(ctx({ ownerId: 1, workspaceId: 'w1', workspaceRole: 'viewer' }))
    expect(await canManageDoc(42, 'd1')).toBe(false)
  })
})

describe('canManageWorkspace', () => {
  it('true only for admin', async () => {
    getMemberRole.mockResolvedValueOnce('admin')
    expect(await canManageWorkspace(1, 'w1')).toBe(true)
  })

  it('false for editor', async () => {
    getMemberRole.mockResolvedValueOnce('editor')
    expect(await canManageWorkspace(1, 'w1')).toBe(false)
  })

  it('false for viewer', async () => {
    getMemberRole.mockResolvedValueOnce('viewer')
    expect(await canManageWorkspace(1, 'w1')).toBe(false)
  })

  it('false for non-members (null role)', async () => {
    getMemberRole.mockResolvedValueOnce(null)
    expect(await canManageWorkspace(1, 'w1')).toBe(false)
  })
})

describe('getWorkspaceRole', () => {
  it('forwards the role as-is (pass-through)', async () => {
    getMemberRole.mockResolvedValueOnce('editor')
    expect(await getWorkspaceRole(1, 'w1')).toBe('editor')
  })

  it('returns null for non-members', async () => {
    getMemberRole.mockResolvedValueOnce(null)
    expect(await getWorkspaceRole(1, 'w1')).toBeNull()
  })
})

describe('getDocAuthz', () => {
  it('returns exists=false + all-false grants for missing doc', async () => {
    getDocWithActorRole.mockResolvedValueOnce(null)
    const r = await getDocAuthz(42, 'missing')
    expect(r).toEqual({
      exists: false,
      ownerId: null,
      workspaceId: null,
      workspaceRole: null,
      isDocOwner: false,
      canView: false,
      canEdit: false,
      canManage: false
    })
  })

  it('owner gets every grant even without a workspace role', async () => {
    getDocWithActorRole.mockResolvedValueOnce(ctx({ ownerId: 42, workspaceId: null, workspaceRole: null }))
    const r = await getDocAuthz(42, 'd1')
    expect(r.exists).toBe(true)
    expect(r.isDocOwner).toBe(true)
    expect(r.canView).toBe(true)
    expect(r.canEdit).toBe(true)
    expect(r.canManage).toBe(true)
  })

  it('admin: canView + canEdit + canManage (non-owner)', async () => {
    getDocWithActorRole.mockResolvedValueOnce(ctx({ ownerId: 1, workspaceId: 'w1', workspaceRole: 'admin' }))
    const r = await getDocAuthz(42, 'd1')
    expect(r.isDocOwner).toBe(false)
    expect(r.canView).toBe(true)
    expect(r.canEdit).toBe(true)
    expect(r.canManage).toBe(true)
  })

  it('editor: canView + canEdit but NOT canManage', async () => {
    getDocWithActorRole.mockResolvedValueOnce(ctx({ ownerId: 1, workspaceId: 'w1', workspaceRole: 'editor' }))
    const r = await getDocAuthz(42, 'd1')
    expect(r.canView).toBe(true)
    expect(r.canEdit).toBe(true)
    expect(r.canManage).toBe(false)
  })

  it('viewer: canView only', async () => {
    // The key non-obvious case: viewer bypasses `private` accessMode via
    // the membership grant (canView=true) but can't edit or manage.
    getDocWithActorRole.mockResolvedValueOnce(ctx({ ownerId: 1, workspaceId: 'w1', workspaceRole: 'viewer' }))
    const r = await getDocAuthz(42, 'd1')
    expect(r.canView).toBe(true)
    expect(r.canEdit).toBe(false)
    expect(r.canManage).toBe(false)
  })

  it('non-member on a workspace doc: nothing granted by membership', async () => {
    // Access to the doc is then governed entirely by the accessMode
    // check elsewhere — this helper reports only the membership side.
    getDocWithActorRole.mockResolvedValueOnce(ctx({ ownerId: 1, workspaceId: 'w1', workspaceRole: null }))
    const r = await getDocAuthz(42, 'd1')
    expect(r.canView).toBe(false)
    expect(r.canEdit).toBe(false)
    expect(r.canManage).toBe(false)
  })

  it('forwards ownerId + workspaceId + workspaceRole verbatim', async () => {
    getDocWithActorRole.mockResolvedValueOnce(ctx({ ownerId: 7, workspaceId: 'ws-abc', workspaceRole: 'admin' }))
    const r = await getDocAuthz(42, 'd1')
    expect(r.ownerId).toBe(7)
    expect(r.workspaceId).toBe('ws-abc')
    expect(r.workspaceRole).toBe('admin')
  })
})
