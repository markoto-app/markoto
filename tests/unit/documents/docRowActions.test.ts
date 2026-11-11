import { describe, it, expect } from 'vitest'
import { docRowActionGroups, workspaceDocPermissions } from '../../../app/utils/workspace/docRowActions'

// The document row "…" menu (dashboard + workspace page): which actions
// each caller gets. Mirrors canEditDoc / canManageDoc on the server.

describe('docRowActionGroups', () => {
  it('owner / manager gets every action, delete in its own group', () => {
    expect(docRowActionGroups({ canEdit: true, canManage: true })).toEqual([
      ['open', 'openNewTab'],
      ['duplicate', 'move'],
      ['delete']
    ])
  })

  it('editor who does not manage the doc can open and duplicate, not move or delete', () => {
    expect(docRowActionGroups({ canEdit: true, canManage: false })).toEqual([
      ['open', 'openNewTab'],
      ['duplicate']
    ])
  })

  it('viewer can only open', () => {
    expect(docRowActionGroups({ canEdit: false, canManage: false })).toEqual([
      ['open', 'openNewTab']
    ])
  })
})

describe('workspaceDocPermissions', () => {
  it('admin manages every doc', () => {
    expect(workspaceDocPermissions('admin', false)).toEqual({ canEdit: true, canManage: true })
  })

  it('editor manages only their own docs', () => {
    expect(workspaceDocPermissions('editor', false)).toEqual({ canEdit: true, canManage: false })
    expect(workspaceDocPermissions('editor', true)).toEqual({ canEdit: true, canManage: true })
  })

  it('viewer edits nothing; an owned doc (e.g. after a demotion) stays theirs to edit and manage', () => {
    expect(workspaceDocPermissions('viewer', false)).toEqual({ canEdit: false, canManage: false })
    expect(workspaceDocPermissions('viewer', true)).toEqual({ canEdit: true, canManage: true })
  })
})
