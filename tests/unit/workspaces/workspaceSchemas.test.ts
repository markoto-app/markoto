import { describe, expect, it } from 'vitest'
import {
  confirmKnowledgeUploadBody,
  createWorkspaceBody,
  inviteMemberBody,
  requestKnowledgeUploadBody,
  updateMemberRoleBody,
  updateWorkspaceBody,
  workspaceInviteParams,
  workspaceMemberParams
} from '../../../shared/api/workspaces'

describe('workspace request schemas', () => {
  it('createWorkspaceBody trims the name and turns a blank description into null', () => {
    expect(createWorkspaceBody.parse({ name: '  Acme ', description: '   ' })).toEqual({ name: 'Acme', description: null })
    expect(createWorkspaceBody.parse({ name: 'A' }).description).toBeUndefined()
    expect(createWorkspaceBody.safeParse({ name: '   ' }).success).toBe(false)
    expect(createWorkspaceBody.safeParse({ name: 'x'.repeat(256) }).success).toBe(false)
    expect(createWorkspaceBody.safeParse({ name: 'A', description: 'x'.repeat(1025) }).success).toBe(false)
    expect(createWorkspaceBody.safeParse(undefined).success).toBe(false)
  })

  it('updateWorkspaceBody accepts a missing body and distinguishes null from absent', () => {
    expect(updateWorkspaceBody.parse(undefined)).toBeUndefined()
    expect(updateWorkspaceBody.parse({})).toEqual({})
    expect(updateWorkspaceBody.parse({ defaultTheme: null })).toEqual({ defaultTheme: null })
    expect(updateWorkspaceBody.parse({ description: '' })).toEqual({ description: null })
    expect(updateWorkspaceBody.safeParse({ name: null }).success).toBe(false)
    expect(updateWorkspaceBody.safeParse({ defaultTheme: { nonsense: true } }).success).toBe(false)
  })

  it('member params and role bodies', () => {
    expect(workspaceMemberParams.parse({ wsId: 'w', userId: '7' }).userId).toBe(7)
    expect(workspaceMemberParams.safeParse({ wsId: 'w', userId: 'notanumber' }).success).toBe(false)
    expect(workspaceMemberParams.safeParse({ wsId: 'w', userId: '0' }).success).toBe(false)
    expect(updateMemberRoleBody.safeParse({ role: 'guest' }).success).toBe(false)
    expect(updateMemberRoleBody.safeParse({ role: 'superadmin' }).success).toBe(false)
    expect(updateMemberRoleBody.parse({ role: 'viewer' })).toEqual({ role: 'viewer' })
    expect(workspaceInviteParams.safeParse({ wsId: 'w', inviteId: '../etc' }).success).toBe(false)
  })

  it('inviteMemberBody allows guests but only known roles', () => {
    expect(inviteMemberBody.parse({ email: 'a@b.c', role: 'guest' }).role).toBe('guest')
    expect(inviteMemberBody.safeParse({ email: 'a@b.c', role: 'godmode' }).success).toBe(false)
    expect(inviteMemberBody.safeParse({ role: 'editor' }).success).toBe(false)
  })

  it('knowledge upload bodies', () => {
    expect(requestKnowledgeUploadBody.safeParse({ filename: 'a.pdf', size: 0 }).success).toBe(false)
    expect(requestKnowledgeUploadBody.safeParse({ filename: 'a.pdf', size: Number.NaN }).success).toBe(false)
    expect(requestKnowledgeUploadBody.safeParse({ filename: '  ', size: 5 }).success).toBe(false)
    expect(confirmKnowledgeUploadBody.parse({ knowledgeId: 'k', s3Key: 's', filename: ' a.PDF ', ext: 'PDF', mimeType: 'm' }))
      .toMatchObject({ filename: 'a.PDF', ext: 'pdf' })
  })
})
