import { getDocWithActorRole } from '../repos/documents'
import { getMemberRole, countAdmins } from '../repos/workspaceMembers'
import { getWorkspace as repoGetWorkspace } from '../repos/workspaces'
import type { WorkspaceRole } from '../../shared/utils/docPermissions'

// Thin authz shortcuts for workspace / document operations. The API here
// is stable (many endpoints auto-import these via Nitro's `server/utils`
// auto-import); internals now delegate to the repos in server/repos/.
//
// Rule of thumb (reiterated from before the repo extraction):
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
 * Does this user have the workspace-member "can view" grant for the doc?
 * A member of ANY role (viewer included) bypasses the `private` accessMode
 * gate. The token endpoint still layers its own accessMode logic on top.
 * For non-workspace docs, this is false — fall back to existing rules.
 */
export async function canViewAsMember(userId: number, docId: string): Promise<boolean> {
  const ctx = await getDocWithActorRole(docId, userId)
  if (!ctx) return false
  if (ctx.ownerId === userId) return true
  if (ctx.workspaceId && ctx.workspaceRole) return true
  return false
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

/**
 * Admin count — used to enforce the "at least one admin" invariant.
 * Called before demoting or removing a member whose role is 'admin'.
 */
export async function countWorkspaceAdmins(wsId: string): Promise<number> {
  return countAdmins(wsId)
}

/**
 * Resolve the workspace row by id. Thin wrapper around the repo call;
 * kept for backward-compat with any caller that auto-imports it.
 */
export async function getWorkspace(wsId: string) {
  return repoGetWorkspace(wsId)
}
