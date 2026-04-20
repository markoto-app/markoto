import { eq, and } from 'drizzle-orm'
import { documents, workspaces, workspaceMembers } from '../db/schema'

export type WorkspaceRole = 'admin' | 'editor' | 'viewer'

/**
 * Central authorization for workspace-member docs. The rule of thumb:
 *
 *   - Owner of the doc is always allowed to do anything to it (unchanged).
 *   - Workspace *admin* gets doc-owner-equivalent rights over every doc in the
 *     workspace (delete any, change access mode, change password).
 *   - Workspace *editor* can edit content / title / theme of any doc in the
 *     workspace, plus delete docs *they created* (via the owner path).
 *   - Workspace *viewer* can view docs in the workspace only.
 *
 * For docs with NULL workspaceId (standalone or anonymous docs), the workspace
 * branch is inert — these helpers return exactly what the legacy owner-only
 * checks did. That's the invariant that keeps standalone + anonymous docs
 * behaving identically to pre-workspaces-collab.
 */

interface DocAuthzContext {
  ownerId: number | null
  workspaceId: string | null
  workspaceRole: WorkspaceRole | null
}

async function loadDocContext(userId: number, docId: string): Promise<DocAuthzContext | null> {
  const db = useDatabase()
  const row = (await db
    .select({
      ownerId: documents.ownerId,
      workspaceId: documents.workspaceId,
      role: workspaceMembers.role
    })
    .from(documents)
    .leftJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, documents.workspaceId),
        eq(workspaceMembers.userId, userId)
      )
    )
    .where(eq(documents.docId, docId))
    .limit(1))[0]
  if (!row) return null
  return {
    ownerId: row.ownerId,
    workspaceId: row.workspaceId,
    workspaceRole: (row.role ?? null) as WorkspaceRole | null
  }
}

export async function getWorkspaceRole(userId: number, wsId: string): Promise<WorkspaceRole | null> {
  const db = useDatabase()
  const row = (await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, wsId), eq(workspaceMembers.userId, userId)))
    .limit(1))[0]
  return (row?.role ?? null) as WorkspaceRole | null
}

/**
 * Does this user have the workspace-member "can view" grant for the doc?
 * A member of ANY role (viewer included) bypasses the `private` accessMode
 * gate. The token endpoint still layers its own accessMode logic on top.
 * For non-workspace docs, this is false — fall back to existing rules.
 */
export async function canViewAsMember(userId: number, docId: string): Promise<boolean> {
  const ctx = await loadDocContext(userId, docId)
  if (!ctx) return false
  if (ctx.ownerId === userId) return true
  if (ctx.workspaceId && ctx.workspaceRole) return true
  return false
}

/**
 * Can this user edit content / title / theme of the doc?
 * True for: doc owner, workspace admin, workspace editor. False for viewer.
 * For non-workspace docs, only true for the owner — same as before.
 */
export async function canEditDoc(userId: number, docId: string): Promise<boolean> {
  const ctx = await loadDocContext(userId, docId)
  if (!ctx) return false
  if (ctx.ownerId === userId) return true
  if (ctx.workspaceRole === 'admin' || ctx.workspaceRole === 'editor') return true
  return false
}

/**
 * Can this user manage doc-level settings that affect sharing with outsiders?
 * Covers: delete, change accessMode, set/change/remove password, delete.
 * True for: doc owner, workspace admin. False for editor, viewer.
 * For non-workspace docs, only true for the owner — same as before.
 */
export async function canManageDoc(userId: number, docId: string): Promise<boolean> {
  const ctx = await loadDocContext(userId, docId)
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
  const ctx = await loadDocContext(userId, docId)
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
  return (await getWorkspaceRole(userId, wsId)) === 'admin'
}

/**
 * Admin count — used to enforce the "at least one admin" invariant.
 * Called before demoting or removing a member whose role is 'admin'.
 */
export async function countWorkspaceAdmins(wsId: string): Promise<number> {
  const db = useDatabase()
  const row = (await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, wsId), eq(workspaceMembers.role, 'admin'))))
  return row.length
}

/**
 * Resolve the workspace row by id. Convenience because several endpoints
 * need the full row (name, ownerId, description) and repeating the query is
 * noisy.
 */
export async function getWorkspace(wsId: string) {
  const db = useDatabase()
  return (await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.workspaceId, wsId))
    .limit(1))[0] ?? null
}
