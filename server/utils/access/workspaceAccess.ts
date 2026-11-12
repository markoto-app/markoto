import { getDocWithActorRole } from '../../repos/access/docAuthz'
import { getMemberRole, getMemberRoleIgnoringSso, getMembershipRole } from '../../repos/access/workspaceRoles'
import { mintWorkspaceAccess, userActor } from '../../repos/proofs/mint'
import type { WorkspaceAccess, WorkspaceGrant, WorkspaceLevel } from '../../repos/proofs'
import { isEffectiveDocOwner, type MembershipRole, type WorkspaceRole } from '../../../shared/utils/documents/docPermissions'

// Thin authz shortcuts for workspace / document operations. Delegates to
// the repos in server/repos/ for the actual queries.
//
// Rule of thumb:
//
//   - Owner of the doc is always allowed to do anything to it — except in
//     a workspace that enforces single sign-on, where ownership counts
//     only while the owner has an effective role there (current SSO
//     grant + membership; `isEffectiveDocOwner`).
//   - Workspace *admin* gets doc-owner-equivalent rights over every doc
//     in the workspace (delete any, change access mode, change password).
//   - Workspace *editor* can edit content / title / theme of any doc in
//     the workspace, plus delete docs *they created* (via the owner path).
//   - Workspace *viewer* can view docs in the workspace only.

/**
 * The caller's role in a workspace, or null if not a member, a guest, or
 * without a current SSO grant in a workspace that enforces it. THE access
 * check for workspace content.
 */
export async function getWorkspaceRole(userId: number, wsId: string): Promise<WorkspaceRole | null> {
  return getMemberRole(wsId, userId)
}

/**
 * The member role without the SSO condition: the SSO settings (break-glass),
 * the SSO sign-in and prompt, SCIM, admin actions about another member.
 * Never for the caller's own access to content.
 */
export async function getWorkspaceRoleIgnoringSso(userId: number, wsId: string): Promise<WorkspaceRole | null> {
  return getMemberRoleIgnoringSso(wsId, userId)
}

/** The raw membership role including `guest`; for member management, never for access to content. */
export async function getWorkspaceMembershipRole(userId: number, wsId: string): Promise<MembershipRole | null> {
  return getMembershipRole(wsId, userId)
}

/**
 * Prove `need` in a workspace for a user: their SSO-checked role (or the
 * role without SSO with `ignoreSso`, the SSO settings' break-glass). Null
 * when the user has no role or one below `need`.
 */
export async function proveWorkspaceAccess<N extends WorkspaceLevel>(
  userId: number,
  wsId: string,
  need: N,
  o?: { ignoreSso?: boolean }
): Promise<WorkspaceAccess<WorkspaceGrant<N>> | null> {
  const role = o?.ignoreSso ? await getMemberRoleIgnoringSso(wsId, userId) : await getMemberRole(wsId, userId)
  return role ? workspaceProofFor(userId, wsId, role, need) : null
}

/** The proof for a role the caller already looked up; null when it is below `need`. */
export function workspaceProofFor<N extends WorkspaceLevel>(userId: number, wsId: string, role: WorkspaceRole, need: N): WorkspaceAccess<WorkspaceGrant<N>> | null {
  if (!workspaceRoleSatisfies(role, need)) return null
  return mintWorkspaceAccess(userActor(userId), wsId, role, need)
}

const RANK: Record<WorkspaceRole, number> = { viewer: 1, editor: 2, admin: 3 }
const NEED_RANK: Record<WorkspaceLevel, number> = { member: 1, editor: 2, admin: 3 }

/** Pure: does `role` satisfy `need`? Unknown values never do. */
export function workspaceRoleSatisfies(role: WorkspaceRole | null, need: WorkspaceLevel): boolean {
  if (role === null || !Object.hasOwn(RANK, role) || !Object.hasOwn(NEED_RANK, need)) return false
  return RANK[role] >= NEED_RANK[need]
}

/**
 * Can this user edit content / title / theme of the doc?
 * True for: doc owner, workspace admin, workspace editor. False for
 * viewer. For non-workspace docs, only true for the owner.
 */
export async function canEditDoc(userId: number, docId: string): Promise<boolean> {
  const ctx = await getDocWithActorRole(docId, userId)
  if (!ctx) return false
  if (isEffectiveDocOwner(ctx, userId)) return true
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
  if (isEffectiveDocOwner(ctx, userId)) return true
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
  canView: boolean // membership view grant (ignores accessMode)
  canEdit: boolean // owner / admin / editor
  canManage: boolean // owner / admin
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
  return {
    exists: true,
    ownerId: ctx.ownerId,
    workspaceId: ctx.workspaceId,
    workspaceRole: ctx.workspaceRole,
    ...docAuthzOf(ctx, userId)
  }
}

/** The membership grants of `userId` on a doc row from `getDocWithActorRole` (pure; access mode not considered). */
export function docAuthzOf(
  row: { ownerId: number | null, ownerAccessSuspended: boolean, workspaceRole: WorkspaceRole | null },
  userId: number | null
): Pick<DocAuthz, 'isDocOwner' | 'canView' | 'canEdit' | 'canManage'> {
  const isDocOwner = isEffectiveDocOwner(row, userId)
  const isAdmin = row.workspaceRole === 'admin'
  const isEditor = row.workspaceRole === 'editor'
  return {
    isDocOwner,
    canView: isDocOwner || row.workspaceRole !== null,
    canEdit: isDocOwner || isAdmin || isEditor,
    canManage: isDocOwner || isAdmin
  }
}

export async function canManageWorkspace(userId: number, wsId: string): Promise<boolean> {
  return (await getMemberRole(wsId, userId)) === 'admin'
}

/** The access bootstrap role lookups, for the access decisions made outside the policies (SSO, SCIM, AI tools, MCP). */
export { getMemberRole, getMemberRoleIgnoringSso, getMembershipRole }
