import { describe, it, expect, vi, beforeEach } from 'vitest'
import { partial } from '../../helpers/fixtures'

// workspaceAccess contract tests. The original 24-test suite was a
// mechanical role-matrix pin (owner returns true, admin returns true,
// etc.): TypeScript already catches role-string typos; these tests
// were documenting what the code visibly does, not what could break.
//
// Kept below: the non-obvious contracts that a refactor could plausibly
// violate WITHOUT TypeScript noticing.

const getDocWithActorRole = vi.fn()
const getMemberRole = vi.fn()

vi.mock('../../../server/repos/access/docAuthz', () => ({ getDocWithActorRole }))
vi.mock('../../../server/repos/access/workspaceRoles', () => ({ getMemberRole }))

const {
  canEditDoc,
  canManageDoc,
  getDocAuthz
} = await import('../../../server/utils/access/workspaceAccess')

type Ctx = Awaited<ReturnType<typeof getDocWithActorRole>>

function ctx(overrides: Partial<NonNullable<Ctx>> = {}): NonNullable<Ctx> {
  return partial<NonNullable<Ctx>>({
    ownerId: 1,
    workspaceId: null,
    accessMode: 'private',
    theme: null,
    workspaceRole: null,
    ...overrides
  })
}

beforeEach(() => {
  getDocWithActorRole.mockReset()
  getMemberRole.mockReset()
})

describe('workspaceAccess: non-obvious contracts', () => {
  it('editor can canEdit but CANNOT canManage (the content-vs-sharing split)', async () => {
    // The key design rule: editors can freely curate content (canEdit=true)
    // but cannot change access mode, password, or delete shared docs
    // (canManage=false). A refactor that consolidated the two into
    // a single "canWrite" would silently open the door for editors to
    // change sharing settings.
    getDocWithActorRole
      .mockResolvedValueOnce(ctx({ ownerId: 1, workspaceId: 'w1', workspaceRole: 'editor' }))
      .mockResolvedValueOnce(ctx({ ownerId: 1, workspaceId: 'w1', workspaceRole: 'editor' }))
    expect(await canEditDoc(42, 'd1')).toBe(true)
    expect(await canManageDoc(42, 'd1')).toBe(false)
  })

  it('viewer CANNOT edit even if they\'re in the same workspace (membership != edit right)', async () => {
    // Viewers get `canView: true` via `getDocAuthz` (membership bypasses
    // private-accessMode gating) but MUST NOT get canEdit. Regression
    // risk: a future "promote viewers to editors on their own docs"
    // feature could accidentally leak edit rights to all viewers.
    getDocWithActorRole.mockResolvedValueOnce(ctx({ ownerId: 1, workspaceId: 'w1', workspaceRole: 'viewer' }))
    const r = await getDocAuthz(42, 'd1')
    expect(r.canView).toBe(true) // membership grant
    expect(r.canEdit).toBe(false) // role gate
    expect(r.canManage).toBe(false)
  })

  it('non-existent doc returns exists=false with every grant off (not a thrown 404)', async () => {
    // Design choice: getDocAuthz NEVER throws, it returns a uniform
    // "nothing granted" shape. Callers that treat `exists` as the 404
    // signal rely on this. If the helper ever started throwing on
    // missing rows, every downstream caller's happy-path would regress
    // into a caught exception.
    getDocWithActorRole.mockResolvedValueOnce(null)
    const r = await getDocAuthz(42, 'missing')
    expect(r.exists).toBe(false)
    expect(r.canView).toBe(false)
    expect(r.canEdit).toBe(false)
    expect(r.canManage).toBe(false)
    expect(r.ownerId).toBeNull()
    expect(r.workspaceRole).toBeNull()
  })

  it('owner of a standalone doc (no workspace) gets ALL grants via the ownerId path', async () => {
    // canEdit/canManage/canView must all resolve true for the owner
    // even when workspaceRole is null (the "I own this doc but it's
    // not in a workspace" case). A refactor that required workspace
    // membership as a precondition would break solo-doc ownership.
    getDocWithActorRole.mockResolvedValueOnce(ctx({ ownerId: 42, workspaceId: null, workspaceRole: null }))
    const r = await getDocAuthz(42, 'solo')
    expect(r.isDocOwner).toBe(true)
    expect(r.canView).toBe(true)
    expect(r.canEdit).toBe(true)
    expect(r.canManage).toBe(true)
  })
})

describe('workspaceAccess: canEditDoc propagates repo errors (fails closed)', () => {
  it('repo throw surfaces to caller (no silent false → skipped authz)', async () => {
    // Defensive: if getDocWithActorRole throws (DB blip), canEditDoc
    // MUST NOT swallow it and return false. A swallow would look like
    // "user has no access" → caller returns a confusing 403 instead of
    // surfacing the real DB error. We want the DB error to propagate
    // so the endpoint returns 500 and operators see the Sentry trace.
    getDocWithActorRole.mockRejectedValueOnce(new Error('connection refused'))
    await expect(canEditDoc(42, 'd1')).rejects.toThrow('connection refused')
  })
})
