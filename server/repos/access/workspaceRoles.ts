import { and, eq, ne } from 'drizzle-orm'
import { workspaceMembers } from '../../db/schema'
import type { MembershipRole, WorkspaceRole } from '../../../shared/utils/documents/docPermissions'
import { useDatabase } from '../../db/client'
import { ssoSatisfiedSql } from '../sso'

// Access bootstrap: workspace role lookups by bare (workspace, user) ids.
// They run BEFORE anything is proven; only the access layer
// (server/utils/access/**) may import them.

/**
 * The caller's role in a workspace, or null if not a member, or if the
 * workspace enforces single sign-on and the caller has no current
 * SSO grant. This is THE access check: every path into a workspace goes
 * through it (or through `getDocWithActorRole`, which applies the same
 * condition), so SSO enforcement holds for the editor, AI, MCP,
 * knowledge and exports alike.
 */
export async function getMemberRole(
  workspaceId: string,
  userId: number
): Promise<WorkspaceRole | null> {
  const db = useDatabase()
  const row = (await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, userId),
      // Guests are not members for anything workspace-wide.
      ne(workspaceMembers.role, 'guest'),
      ssoSatisfiedSql(workspaceMembers.workspaceId, userId)
    ))
    .limit(1))[0]
  return (row?.role ?? null) as WorkspaceRole | null
}

/**
 * The membership role WITHOUT the SSO condition. Only for the places
 * that must see a member who hasn't signed in through the workspace's
 * IdP: the SSO settings (admins can fix a broken IdP, the only
 * break-glass), the "sign in with SSO" prompt, the SSO sign-in itself,
 * SCIM, and admin actions about ANOTHER member (removal). Never for the
 * caller's own access to content.
 */
export async function getMemberRoleIgnoringSso(
  workspaceId: string,
  userId: number
): Promise<WorkspaceRole | null> {
  const row = (await useDatabase()
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId), ne(workspaceMembers.role, 'guest')))
    .limit(1))[0]
  return (row?.role ?? null) as WorkspaceRole | null
}

/**
 * The raw membership row's role INCLUDING `guest`. For the member
 * list, member removal and role changes, never for access decisions.
 */
export async function getMembershipRole(
  workspaceId: string,
  userId: number
): Promise<MembershipRole | null> {
  const row = (await useDatabase()
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1))[0]
  return row?.role ?? null
}
