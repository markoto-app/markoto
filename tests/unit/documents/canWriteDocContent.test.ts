import { describe, it, expect } from 'vitest'
import type { DocAuthzRow } from '../../../server/repos/access/docAuthz'
import { canWriteDocContent } from '../../../server/utils/access/docProof'

// canWriteDocContent: the rule behind `allow.doc('write-content')`, which AI
// prompt, @ai comment trigger, restore, dictation and image upload use to
// let a logged-in user write to a doc server-side. Any bug here lets a user
// write to a doc the editor itself would open read-only (or not at all).
//
// The rule is the editor's own Y.js token rule (`decideTokenAccess`
// granting a writable token), so this file pins the whole
// (accessMode × role × ownership) matrix.

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
    suggestionPolicy: { required: false, exemptRoles: ['admin'], viewersMaySuggest: false },
    anonCreatorKeyHash: null,
    title: 'Doc',
    description: '',
    audience: 'technical',
    language: 'en',
    templateId: 'blank',
    ...overrides
  }
}

describe('canWriteDocContent', () => {
  it.each(['private', 'open-edit', 'open-view', 'password-protected'] as const)(
    'owner can write on a %s doc',
    (accessMode) => {
      expect(canWriteDocContent(row({ ownerId: ACTOR, accessMode }), ACTOR)).toBe(true)
    }
  )

  it.each([
    ['admin', 'private'],
    ['editor', 'private'],
    ['editor', 'open-view'],
    ['editor', 'password-protected'],
    ['admin', 'open-edit']
  ] as const)('workspace %s can write on a %s doc', (workspaceRole, accessMode) => {
    expect(canWriteDocContent(row({ workspaceId: 'ws', workspaceRole, accessMode }), ACTOR)).toBe(true)
  })

  it('a logged-in non-member can write on an open-edit doc (public edit grant)', () => {
    expect(canWriteDocContent(row({ accessMode: 'open-edit' }), ACTOR)).toBe(true)
  })

  it('a workspace VIEWER cannot write on an open-edit doc (viewer wins over the public grant)', () => {
    expect(canWriteDocContent(row({ workspaceId: 'ws', workspaceRole: 'viewer', accessMode: 'open-edit' }), ACTOR)).toBe(false)
  })

  it.each(['private', 'open-view', 'password-protected'] as const)(
    'a workspace viewer cannot write on a %s doc',
    (accessMode) => {
      expect(canWriteDocContent(row({ workspaceId: 'ws', workspaceRole: 'viewer', accessMode }), ACTOR)).toBe(false)
    }
  )

  it.each(['private', 'open-view', 'password-protected'] as const)(
    'a non-member cannot write on a %s doc',
    (accessMode) => {
      expect(canWriteDocContent(row({ accessMode }), ACTOR)).toBe(false)
    }
  )

  it.each(['private', 'open-view', 'password-protected'] as const)(
    'an owner whose ownership is suspended by single sign-on cannot write on a %s doc',
    (accessMode) => {
      expect(canWriteDocContent(row({ ownerId: ACTOR, workspaceId: 'ws', accessMode, ownerAccessSuspended: true }), ACTOR)).toBe(false)
    }
  )

  it('an owner whose ownership is suspended keeps only the public edit grant of an open-edit doc', () => {
    expect(canWriteDocContent(row({ ownerId: ACTOR, workspaceId: 'ws', accessMode: 'open-edit', ownerAccessSuspended: true }), ACTOR)).toBe(true)
  })
})
