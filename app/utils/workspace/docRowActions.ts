// Which actions a document row's "…" menu offers (dashboard + workspace
// page, `components/document/DocRowMenu.vue`). Pure so the permission
// matrix is unit-testable without mounting Nuxt UI.
//
// Mirrors the server's checks (the UI gate is UX only — every endpoint
// re-checks):
//   - open / open in new tab: anyone who can see the row.
//   - duplicate: anyone who can edit the document (`canEditDoc`).
//   - move / delete: owner or workspace admin (`canManageDoc`).

export type DocRowAction = 'open' | 'openNewTab' | 'duplicate' | 'move' | 'delete'

export interface DocRowPermissions {
  canEdit: boolean
  canManage: boolean
}

/** Action groups in display order; empty groups are dropped. */
export function docRowActionGroups(perms: DocRowPermissions): DocRowAction[][] {
  const groups: DocRowAction[][] = [['open', 'openNewTab']]
  const change: DocRowAction[] = []
  if (perms.canEdit || perms.canManage) change.push('duplicate')
  if (perms.canManage) change.push('move')
  if (change.length > 0) groups.push(change)
  if (perms.canManage) groups.push(['delete'])
  return groups
}

/**
 * Workspace page: the caller's role in the workspace plus whether they own
 * the row — same rules as the server's `getDocAuthz` (edit = owner /
 * admin / editor, manage = owner / admin). Viewers only open docs they
 * don't own.
 */
export function workspaceDocPermissions(
  role: 'admin' | 'editor' | 'viewer',
  isOwner: boolean
): DocRowPermissions {
  return {
    canEdit: role === 'admin' || role === 'editor' || isOwner,
    canManage: role === 'admin' || isOwner
  }
}
