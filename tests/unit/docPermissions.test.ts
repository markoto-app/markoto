import { describe, it, expect } from 'vitest'
import {
  decideTokenAccess,
  decideFileAccess,
  decideActivityAccess,
  decideDocDelete,
  type DocState,
  type ActorState,
  type AccessMode,
  type WorkspaceRole
} from '../../shared/utils/docPermissions'

// Helper builders. Keep these tiny — every test reads better when the setup
// is a literal struct, so these only fill common defaults.
function doc(overrides: Partial<DocState> = {}): DocState {
  return {
    ownerId: null,
    workspaceId: null,
    accessMode: 'open-edit',
    ...overrides
  }
}

function actor(overrides: Partial<ActorState> = {}): ActorState {
  return {
    userId: null,
    workspaceRole: null,
    hasValidDocJwt: false,
    ...overrides
  }
}

const ALL_MODES: AccessMode[] = ['private', 'open-edit', 'open-view', 'password-protected']
const ALL_ROLES: (WorkspaceRole | null)[] = ['admin', 'editor', 'viewer', null]

describe('decideTokenAccess', () => {
  describe('doc owner', () => {
    it.each(ALL_MODES)('owner gets full edit on %s doc', (mode) => {
      const d = doc({ ownerId: 42, workspaceId: 'ws1', accessMode: mode })
      const a = actor({ userId: 42 })
      expect(decideTokenAccess(d, a)).toEqual({ outcome: 'allow', readOnly: false })
    })

    it('owner who is also workspace viewer still gets full edit', () => {
      // Edge case: the original workspace creator demoted to viewer but
      // still owns docs they created. Owner beats role.
      const d = doc({ ownerId: 42, workspaceId: 'ws1', accessMode: 'private' })
      const a = actor({ userId: 42, workspaceRole: 'viewer' })
      expect(decideTokenAccess(d, a)).toEqual({ outcome: 'allow', readOnly: false })
    })

    it('owner on open-edit stays full-edit even if role is viewer', () => {
      const d = doc({ ownerId: 42, workspaceId: 'ws1', accessMode: 'open-edit' })
      const a = actor({ userId: 42, workspaceRole: 'viewer' })
      expect(decideTokenAccess(d, a)).toEqual({ outcome: 'allow', readOnly: false })
    })
  })

  describe('private mode', () => {
    it('anonymous gets forbidden', () => {
      const d = doc({ ownerId: 42, accessMode: 'private' })
      const a = actor()
      expect(decideTokenAccess(d, a)).toMatchObject({ outcome: 'forbidden' })
    })

    it('logged-in non-member non-owner gets forbidden', () => {
      const d = doc({ ownerId: 42, accessMode: 'private' })
      const a = actor({ userId: 99 })
      expect(decideTokenAccess(d, a)).toMatchObject({ outcome: 'forbidden' })
    })

    it.each([['admin'], ['editor']] as const)('workspace %s gets full edit', (role) => {
      const d = doc({ ownerId: 42, workspaceId: 'ws1', accessMode: 'private' })
      const a = actor({ userId: 99, workspaceRole: role })
      expect(decideTokenAccess(d, a)).toEqual({ outcome: 'allow', readOnly: false })
    })

    it('workspace viewer gets read-only', () => {
      const d = doc({ ownerId: 42, workspaceId: 'ws1', accessMode: 'private' })
      const a = actor({ userId: 99, workspaceRole: 'viewer' })
      expect(decideTokenAccess(d, a)).toEqual({ outcome: 'allow', readOnly: true })
    })
  })

  describe('open-edit mode', () => {
    it('anonymous gets full edit', () => {
      const d = doc({ accessMode: 'open-edit' })
      const a = actor()
      expect(decideTokenAccess(d, a)).toEqual({ outcome: 'allow', readOnly: false })
    })

    it('logged-in non-member gets full edit', () => {
      const d = doc({ ownerId: 42, accessMode: 'open-edit' })
      const a = actor({ userId: 99 })
      expect(decideTokenAccess(d, a)).toEqual({ outcome: 'allow', readOnly: false })
    })

    it.each([['admin'], ['editor']] as const)('workspace %s gets full edit', (role) => {
      const d = doc({ ownerId: 42, workspaceId: 'ws1', accessMode: 'open-edit' })
      const a = actor({ userId: 99, workspaceRole: role })
      expect(decideTokenAccess(d, a)).toEqual({ outcome: 'allow', readOnly: false })
    })

    it('workspace viewer gets read-only even on open-edit', () => {
      // Role wins over public grant — demoting to viewer means "can't edit
      // anything in this workspace, regardless of how the doc is shared".
      const d = doc({ ownerId: 42, workspaceId: 'ws1', accessMode: 'open-edit' })
      const a = actor({ userId: 99, workspaceRole: 'viewer' })
      expect(decideTokenAccess(d, a)).toEqual({ outcome: 'allow', readOnly: true })
    })
  })

  describe('open-view mode', () => {
    it('anonymous gets read-only', () => {
      const d = doc({ accessMode: 'open-view' })
      const a = actor()
      expect(decideTokenAccess(d, a)).toEqual({ outcome: 'allow', readOnly: true })
    })

    it('logged-in non-member gets read-only', () => {
      const d = doc({ ownerId: 42, accessMode: 'open-view' })
      const a = actor({ userId: 99 })
      expect(decideTokenAccess(d, a)).toEqual({ outcome: 'allow', readOnly: true })
    })

    it.each([['admin'], ['editor']] as const)('workspace %s gets full edit', (role) => {
      const d = doc({ ownerId: 42, workspaceId: 'ws1', accessMode: 'open-view' })
      const a = actor({ userId: 99, workspaceRole: role })
      expect(decideTokenAccess(d, a)).toEqual({ outcome: 'allow', readOnly: false })
    })

    it('workspace viewer gets read-only', () => {
      const d = doc({ ownerId: 42, workspaceId: 'ws1', accessMode: 'open-view' })
      const a = actor({ userId: 99, workspaceRole: 'viewer' })
      expect(decideTokenAccess(d, a)).toEqual({ outcome: 'allow', readOnly: true })
    })
  })

  describe('password-protected mode', () => {
    it('anonymous must enter password', () => {
      const d = doc({ accessMode: 'password-protected' })
      const a = actor()
      expect(decideTokenAccess(d, a)).toMatchObject({ outcome: 'password-required' })
    })

    it('logged-in non-member must enter password', () => {
      const d = doc({ ownerId: 42, accessMode: 'password-protected' })
      const a = actor({ userId: 99 })
      expect(decideTokenAccess(d, a)).toMatchObject({ outcome: 'password-required' })
    })

    it.each([['admin'], ['editor']] as const)('workspace %s bypasses password with full edit', (role) => {
      const d = doc({ ownerId: 42, workspaceId: 'ws1', accessMode: 'password-protected' })
      const a = actor({ userId: 99, workspaceRole: role })
      expect(decideTokenAccess(d, a)).toEqual({ outcome: 'allow', readOnly: false })
    })

    it('workspace viewer bypasses password with read-only', () => {
      // Spec invariant: viewers see every workspace doc regardless of
      // accessMode. Breaking this is how we silently wall a viewer out of
      // a doc they should be able to read.
      const d = doc({ ownerId: 42, workspaceId: 'ws1', accessMode: 'password-protected' })
      const a = actor({ userId: 99, workspaceRole: 'viewer' })
      expect(decideTokenAccess(d, a)).toEqual({ outcome: 'allow', readOnly: true })
    })
  })

  describe('anonymous doc (no owner, no workspace)', () => {
    // Anon docs are always open-edit in practice, but the decision fn
    // should still behave sanely for the other modes if someone constructs
    // one (e.g. via a race, or a future code path).
    it('anonymous on anon open-edit doc gets full edit', () => {
      const d = doc({ accessMode: 'open-edit' })
      expect(decideTokenAccess(d, actor())).toEqual({ outcome: 'allow', readOnly: false })
    })

    it('anonymous on anon private doc is forbidden', () => {
      const d = doc({ accessMode: 'private' })
      expect(decideTokenAccess(d, actor())).toMatchObject({ outcome: 'forbidden' })
    })
  })
})

describe('decideFileAccess', () => {
  // Files are a 302-redirect to a presigned URL. Threat model: can the
  // actor see the file bytes? Read-only distinction doesn't apply here.
  describe('public modes', () => {
    it.each([['open-edit'], ['open-view']] as const)('anonymous is allowed on %s', (mode) => {
      const d = doc({ ownerId: 42, accessMode: mode })
      expect(decideFileAccess(d, actor())).toEqual({ outcome: 'allow' })
    })

    it.each([['open-edit'], ['open-view']] as const)('logged-in non-member is allowed on %s', (mode) => {
      const d = doc({ ownerId: 42, accessMode: mode })
      expect(decideFileAccess(d, actor({ userId: 99 }))).toEqual({ outcome: 'allow' })
    })
  })

  describe('private mode', () => {
    it('anonymous is denied', () => {
      const d = doc({ ownerId: 42, accessMode: 'private' })
      expect(decideFileAccess(d, actor())).toEqual({ outcome: 'deny' })
    })

    it('logged-in non-member is denied', () => {
      const d = doc({ ownerId: 42, accessMode: 'private' })
      expect(decideFileAccess(d, actor({ userId: 99 }))).toEqual({ outcome: 'deny' })
    })

    it('owner is allowed', () => {
      const d = doc({ ownerId: 42, accessMode: 'private' })
      expect(decideFileAccess(d, actor({ userId: 42 }))).toEqual({ outcome: 'allow' })
    })

    it.each(['admin', 'editor', 'viewer'] as WorkspaceRole[])('workspace %s is allowed', (role) => {
      const d = doc({ ownerId: 42, workspaceId: 'ws1', accessMode: 'private' })
      expect(decideFileAccess(d, actor({ userId: 99, workspaceRole: role }))).toEqual({ outcome: 'allow' })
    })

    it('anonymous with valid doc JWT is allowed', () => {
      // Password-verified anon has no session but holds a scoped JWT.
      const d = doc({ ownerId: 42, accessMode: 'private' })
      expect(decideFileAccess(d, actor({ hasValidDocJwt: true }))).toEqual({ outcome: 'allow' })
    })
  })

  describe('password-protected mode', () => {
    it('anonymous without JWT is denied', () => {
      const d = doc({ ownerId: 42, accessMode: 'password-protected' })
      expect(decideFileAccess(d, actor())).toEqual({ outcome: 'deny' })
    })

    it('logged-in non-member without JWT is denied', () => {
      const d = doc({ ownerId: 42, accessMode: 'password-protected' })
      expect(decideFileAccess(d, actor({ userId: 99 }))).toEqual({ outcome: 'deny' })
    })

    it('owner is allowed', () => {
      const d = doc({ ownerId: 42, accessMode: 'password-protected' })
      expect(decideFileAccess(d, actor({ userId: 42 }))).toEqual({ outcome: 'allow' })
    })

    it.each(['admin', 'editor', 'viewer'] as WorkspaceRole[])('workspace %s is allowed without JWT', (role) => {
      // Spec: workspace members bypass password — that includes fetching
      // images from the doc even on first visit before any password prompt.
      const d = doc({ ownerId: 42, workspaceId: 'ws1', accessMode: 'password-protected' })
      expect(decideFileAccess(d, actor({ userId: 99, workspaceRole: role }))).toEqual({ outcome: 'allow' })
    })

    it('anonymous with valid doc JWT is allowed', () => {
      const d = doc({ ownerId: 42, accessMode: 'password-protected' })
      expect(decideFileAccess(d, actor({ hasValidDocJwt: true }))).toEqual({ outcome: 'allow' })
    })
  })
})

describe('decideActivityAccess', () => {
  // Activity = edit log (timestamps + user names). Same sensitivity as
  // file contents — so the rules should match decideFileAccess exactly.
  // If these two ever drift, the activity log becomes a side-channel.
  it('shares every rule with decideFileAccess (random sample)', () => {
    const samples: { d: DocState, a: ActorState }[] = [
      { d: doc({ ownerId: 42, accessMode: 'private' }), a: actor() },
      { d: doc({ ownerId: 42, accessMode: 'private' }), a: actor({ userId: 42 }) },
      { d: doc({ ownerId: 42, workspaceId: 'ws1', accessMode: 'private' }), a: actor({ userId: 99, workspaceRole: 'viewer' }) },
      { d: doc({ accessMode: 'open-view' }), a: actor() },
      { d: doc({ accessMode: 'password-protected' }), a: actor({ hasValidDocJwt: true }) },
      { d: doc({ ownerId: 42, accessMode: 'password-protected' }), a: actor({ userId: 99 }) }
    ]
    for (const { d, a } of samples) {
      expect(decideActivityAccess(d, a)).toEqual(decideFileAccess(d, a))
    }
  })
})

describe('decideDocDelete', () => {
  describe('anonymous doc (no owner, no workspace)', () => {
    // Only the browser that created an anonymous doc (it presents the
    // creator key) may delete it; everyone else can still edit it.
    it('the creating browser can delete its anon open-edit doc', () => {
      const d = doc({ accessMode: 'open-edit' })
      expect(decideDocDelete(d, actor({ isAnonCreator: true }))).toEqual({ outcome: 'allow' })
    })

    it('another anonymous caller cannot delete an anon doc', () => {
      const d = doc({ accessMode: 'open-edit' })
      expect(decideDocDelete(d, actor())).toEqual({ outcome: 'deny', reason: 'not-anon-creator' })
      expect(decideDocDelete(d, actor({ isAnonCreator: false }))).toMatchObject({ outcome: 'deny' })
    })

    it('a logged-in non-creator cannot delete an anon doc', () => {
      const d = doc({ accessMode: 'open-edit' })
      expect(decideDocDelete(d, actor({ userId: 99 }))).toMatchObject({ outcome: 'deny' })
    })

    it('a logged-in user who created it in this browser can delete it', () => {
      const d = doc({ accessMode: 'open-edit' })
      expect(decideDocDelete(d, actor({ userId: 99, isAnonCreator: true }))).toEqual({ outcome: 'allow' })
    })

    it.each(['private', 'open-view', 'password-protected'] as AccessMode[])(
      'refuses delete on anon %s doc (defensive)',
      (mode) => {
        // Anon docs should never exist in these modes (no owner to scope
        // them to). If one does, refuse delete rather than blow it away.
        const d = doc({ accessMode: mode })
        expect(decideDocDelete(d, actor({ isAnonCreator: true }))).toMatchObject({ outcome: 'deny' })
      }
    )
  })

  describe('owned standalone doc (no workspace)', () => {
    it('owner can delete', () => {
      const d = doc({ ownerId: 42 })
      expect(decideDocDelete(d, actor({ userId: 42 }))).toEqual({ outcome: 'allow' })
    })

    it('anonymous cannot delete (returns authentication-required)', () => {
      const d = doc({ ownerId: 42 })
      const decision = decideDocDelete(d, actor())
      expect(decision.outcome).toBe('deny')
      expect(decision.reason).toBe('authentication-required')
    })

    it('logged-in non-owner cannot delete', () => {
      const d = doc({ ownerId: 42 })
      const decision = decideDocDelete(d, actor({ userId: 99 }))
      expect(decision.outcome).toBe('deny')
      expect(decision.reason).toBe('not-authorized')
    })

    it.each(ALL_MODES)('ownership rule holds regardless of accessMode (%s)', (mode) => {
      const d = doc({ ownerId: 42, accessMode: mode })
      expect(decideDocDelete(d, actor({ userId: 42 }))).toEqual({ outcome: 'allow' })
      expect(decideDocDelete(d, actor({ userId: 99 }))).toMatchObject({ outcome: 'deny' })
    })
  })

  describe('workspace doc', () => {
    it('owner can delete (editor-own path)', () => {
      const d = doc({ ownerId: 42, workspaceId: 'ws1' })
      const a = actor({ userId: 42, workspaceRole: 'editor' })
      expect(decideDocDelete(d, a)).toEqual({ outcome: 'allow' })
    })

    it('workspace admin can delete any doc', () => {
      const d = doc({ ownerId: 42, workspaceId: 'ws1' })
      const a = actor({ userId: 99, workspaceRole: 'admin' })
      expect(decideDocDelete(d, a)).toEqual({ outcome: 'allow' })
    })

    it('workspace editor cannot delete someone else\'s doc', () => {
      const d = doc({ ownerId: 42, workspaceId: 'ws1' })
      const a = actor({ userId: 99, workspaceRole: 'editor' })
      expect(decideDocDelete(d, a)).toMatchObject({ outcome: 'deny' })
    })

    it('workspace viewer cannot delete even their own doc', () => {
      // Note: in practice viewers can't create docs, but defensive check
      // in case a demoted editor has existing docs.
      const d = doc({ ownerId: 42, workspaceId: 'ws1' })
      const a = actor({ userId: 42, workspaceRole: 'viewer' })
      // Owner path still wins.
      expect(decideDocDelete(d, a)).toEqual({ outcome: 'allow' })

      const d2 = doc({ ownerId: 42, workspaceId: 'ws1' })
      const a2 = actor({ userId: 99, workspaceRole: 'viewer' })
      expect(decideDocDelete(d2, a2)).toMatchObject({ outcome: 'deny' })
    })

    it('non-member cannot delete workspace doc', () => {
      const d = doc({ ownerId: 42, workspaceId: 'ws1' })
      const a = actor({ userId: 99 })
      expect(decideDocDelete(d, a)).toMatchObject({ outcome: 'deny' })
    })

    it('anonymous cannot delete workspace doc', () => {
      const d = doc({ ownerId: 42, workspaceId: 'ws1' })
      expect(decideDocDelete(d, actor())).toMatchObject({
        outcome: 'deny',
        reason: 'authentication-required'
      })
    })
  })
})

// Meta-sanity: the full matrix should never produce "undefined" decisions.
// Cheap insurance against a future `switch` case gap.
describe('exhaustiveness', () => {
  it('decideTokenAccess returns a decision for every (mode × role × owner?) combination', () => {
    for (const mode of ALL_MODES) {
      for (const role of ALL_ROLES) {
        for (const isOwner of [true, false]) {
          for (const hasSession of [true, false]) {
            const d = doc({
              ownerId: isOwner || hasSession ? 42 : null,
              workspaceId: role !== null ? 'ws1' : null,
              accessMode: mode
            })
            const a = actor({
              userId: hasSession ? (isOwner ? 42 : 99) : null,
              workspaceRole: role
            })
            const result = decideTokenAccess(d, a)
            expect(['allow', 'forbidden', 'password-required']).toContain(result.outcome)
            expect(typeof result.readOnly).toBe('boolean')
          }
        }
      }
    }
  })
})
