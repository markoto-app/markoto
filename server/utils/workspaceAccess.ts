import { getDocWithActorRole } from '../repos/documents'
import { getMemberRole } from '../repos/workspaceMembers'
import type { WorkspaceRole } from '../../shared/utils/docPermissions'

// Thin authz shortcuts for workspace / document operations. Delegates to
// the repos in server/repos/ for the actual queries.
//
// Rule of thumb:
//
//   - Owner of the doc is always allowed to do anything to it.
//   - Workspace *admin* gets doc-owner-equivalent rights over every doc
//     in the workspace (delete any, change access mode, change password).
//   - Workspace *editor* can edit content / title / theme of any doc in
//     the workspace, plus delete docs *they created* (via the owner path).
//   - Workspace *viewer* can view docs in the workspace only.

export async function getWorkspaceRole(userId: number, wsId: string): Promise<WorkspaceRole | null> {
  return getMemberRole(wsId, userId)
}

/**
 * Can this user edit content / title / theme of the doc?
 * True for: doc owner, workspace admin, workspace editor. False for
 * viewer. For non-workspace docs, only true for the owner.
 */
export async function canEditDoc(userId: number, docId: string): Promise<boolean> {
  const ctx = await getDocWithActorRole(docId, userId)
  if (!ctx) return false
  if (ctx.ownerId === userId) return true
  if (ctx.workspaceRole === 'admin' || ctx.workspaceRole === 'editor') return true
  return false
}

/**
 * Can this user manage doc-level settings that affect sharing with outsiders?
 * Covers: delete, change accessMode, set/change/remove password.
 * True for: doc owner, workspace admin. False for editor, viewer.
 * For non-workspace docs, only true for the owner.
 */
export async function canManageDoc(userId: number, docId: string): Promise<boolean> {
  const ctx = await getDocWithActorRole(docId, userId)
  if (!ctx) return false
  if (ctx.ownerId === userId) return true
  if (ctx.workspaceRole === 'admin') return true
  return false
}

/**
 * Full authz snapshot. Useful when an endpoint needs to make multiple
 * gating decisions from the same doc — avoids re-querying per check.
 */
export interface DocAuthz {
  exists: boolean
  ownerId: number | null
  workspaceId: string | null
  workspaceRole: WorkspaceRole | null
  isDocOwner: boolean
  canView: boolean    // membership view grant (ignores accessMode)
  canEdit: boolean    // owner / admin / editor
  canManage: boolean  // owner / admin
}

export async function getDocAuthz(userId: number, docId: string): Promise<DocAuthz> {
  const ctx = await getDocWithActorRole(docId, userId)
  if (!ctx) {
    return {
      exists: false,
      ownerId: null,
      workspaceId: null,
      workspaceRole: null,
      isDocOwner: false,
      canView: false,
      canEdit: false,
      canManage: false
    }
  }
  const isDocOwner = ctx.ownerId === userId
  const hasRole = ctx.workspaceRole !== null
  const isAdmin = ctx.workspaceRole === 'admin'
  const isEditor = ctx.workspaceRole === 'editor'
  return {
    exists: true,
    ownerId: ctx.ownerId,
    workspaceId: ctx.workspaceId,
    workspaceRole: ctx.workspaceRole,
    isDocOwner,
    canView: isDocOwner || hasRole,
    canEdit: isDocOwner || isAdmin || isEditor,
    canManage: isDocOwner || isAdmin
  }
}

export async function canManageWorkspace(userId: number, wsId: string): Promise<boolean> {
  return (await getMemberRole(wsId, userId)) === 'admin'
}
