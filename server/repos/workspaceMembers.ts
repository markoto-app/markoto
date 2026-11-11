import { and, eq, ne, sql } from 'drizzle-orm'
import { workspaceMembers, users } from '../db/schema'
import type { MembershipRole, WorkspaceRole } from '../../shared/utils/documents/docPermissions'
import { useDatabase } from '../utils/platform/database'
import { ConflictError, LastAdminError, NotFoundError } from './errors'
import { ssoSatisfiedSql } from './sso'

// Workspace-membership repository. This table is the authorisation source
// of truth for workspaces; every mutation here needs to preserve the
// "≥1 admin" invariant, which is why several of these functions are
// transactional or do their own count-then-mutate bookkeeping.

/** setRole on a guest (WP11): invite them as a member instead. */
class GuestRoleChangeError extends ConflictError {
  constructor() {
    super('Guests can\'t get a team role. Remove them and invite them as a member instead.')
    this.name = 'GuestRoleChangeError'
  }
}

export interface MemberRow {
  userId: number
  name: string
  email: string | null
  login: string | null
  /** `guest` included (WP11): the member list shows guests too. */
  role: MembershipRole
  joinedAt: Date
}

/**
 * The caller's role in a workspace, or null if not a member — or if the
 * workspace enforces single sign-on (WP14) and the caller has no current
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
      // Guests (WP11) are not members for anything workspace-wide.
      ne(workspaceMembers.role, 'guest'),
      ssoSatisfiedSql(workspaceMembers.workspaceId, userId)
    ))
    .limit(1))[0]
  return (row?.role ?? null) as WorkspaceRole | null
}

/**
 * The membership role WITHOUT the SSO condition. Only for the places
 * that must see a member who hasn't signed in through the workspace's
 * IdP: the SSO settings (admins can fix a broken IdP — the only
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
 * The raw membership row's role INCLUDING `guest` (WP11). For the member
 * list, member removal and role changes — never for access decisions.
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

/**
 * Full member roster for a workspace, ordered admin → editor → viewer,
 * then by joinedAt ascending within each role.
 */
export async function listMembers(workspaceId: string): Promise<MemberRow[]> {
  const db = useDatabase()
  return db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      login: users.login,
      role: workspaceMembers.role,
      joinedAt: workspaceMembers.joinedAt
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .orderBy(sql`case ${workspaceMembers.role} when 'admin' then 0 when 'editor' then 1 else 2 end, ${workspaceMembers.joinedAt} asc`)
}

/**
 * Roster for the presence bar — joined with the doc's ownerId so the UI
 * can render an "owner" badge. Same ordering as listMembers().
 */
export async function listMembersForDoc(
  workspaceId: string,
  docOwnerId: number | null
): Promise<Array<{
  userId: number
  name: string
  login: string | null
  role: WorkspaceRole
  isDocOwner: boolean
}>> {
  const db = useDatabase()
  return db
    .select({
      userId: users.id,
      name: users.name,
      login: users.login,
      role: workspaceMembers.role,
      isDocOwner: sql<boolean>`${users.id} = ${docOwnerId}`
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    // Guests (WP11) aren't part of the team roster (presence, mentions).
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), ne(workspaceMembers.role, 'guest')))
    .orderBy(sql`case ${workspaceMembers.role} when 'admin' then 0 when 'editor' then 1 else 2 end, ${workspaceMembers.joinedAt} asc`) as Promise<Array<{ userId: number, name: string, login: string | null, role: WorkspaceRole, isDocOwner: boolean }>>
}

/**
 * How many admins does this workspace have right now? Used to enforce
 * the last-admin invariant before demotion / removal.
 */
export async function countAdmins(workspaceId: string): Promise<number> {
  const db = useDatabase()
  const rows = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.role, 'admin')
    ))
  return rows.length
}

/**
 * How many members does this workspace have right now? Used for the
 * plan's `membersPerWorkspace` limit (together with open invitations).
 */
export async function countMembers(workspaceId: string): Promise<number> {
  const db = useDatabase()
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(workspaceMembers)
    // Guests (WP11) take no seat and don't count towards the member limit.
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), ne(workspaceMembers.role, 'guest')))
  return rows[0]?.n ?? 0
}

/** Guests of the workspace (WP11) — for the guest cap. */
export async function countGuests(workspaceId: string): Promise<number> {
  const rows = await useDatabase()
    .select({ n: sql<number>`count(*)::int` })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, 'guest')))
  return rows[0]?.n ?? 0
}

/**
 * Insert a new member. Does NOT check whether the caller is allowed to —
 * endpoints gate admin-only via getMemberRole beforehand. Does check
 * duplicate insertion and throws ConflictError via the schema-level PK.
 */
export async function addMember(
  workspaceId: string,
  userId: number,
  role: WorkspaceRole
): Promise<void> {
  const db = useDatabase()
  await db.insert(workspaceMembers).values({ workspaceId, userId, role })
}

/**
 * Change a member's role. Enforces the ≥1-admin invariant: if the
 * target is currently admin and the new role isn't, refuses when
 * they're the last admin.
 *
 * Concurrency: runs in a transaction AND takes a `FOR UPDATE` row lock
 * on every admin row in the workspace during the count. Without the
 * lock, two concurrent demotions both read admin_count=2 under pg's
 * default READ COMMITTED isolation, both decide it's safe, and both
 * commit — leaving zero admins. The lock makes the second transaction
 * block until the first commits, at which point its count sees the
 * post-demotion state and throws LastAdminError. (A repo test caught
 * this exact race; DO NOT remove the FOR UPDATE clause.)
 *
 * Returns the previous role, or throws NotFoundError if the user isn't
 * a member of the workspace.
 */
export async function setRole(
  workspaceId: string,
  userId: number,
  nextRole: WorkspaceRole
): Promise<WorkspaceRole> {
  const db = useDatabase()
  return db.transaction(async (tx): Promise<WorkspaceRole> => {
    const existing = (await tx
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      ))
      .for('update')
      .limit(1))[0]
    if (!existing) throw new NotFoundError('Member')

    const prev = existing.role
    // A guest (WP11) becomes a member only through an invitation (which
    // checks seats); there is no role change into or out of `guest`.
    if (prev === 'guest') throw new GuestRoleChangeError()
    if (prev === 'admin' && nextRole !== 'admin') {
      // Lock every admin row in this workspace — concurrent demotions
      // on DIFFERENT admin users would otherwise both see count=2 and
      // both proceed. The lock serializes them.
      const admins = await tx
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.role, 'admin')
        ))
        .for('update')
      if (admins.length <= 1) throw new LastAdminError()
    }

    if (prev !== nextRole) {
      await tx
        .update(workspaceMembers)
        .set({ role: nextRole })
        .where(and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId)
        ))
    }
    return prev
  })
}

/**
 * Remove a member. Enforces the ≥1-admin invariant — if the target is
 * the last admin, refuses. Same FOR UPDATE lock story as setRole.
 * Returns the removed role, or throws NotFoundError.
 */
export async function removeMember(
  workspaceId: string,
  userId: number
): Promise<MembershipRole> {
  const db = useDatabase()
  return db.transaction(async (tx) => {
    const existing = (await tx
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      ))
      .for('update')
      .limit(1))[0]
    if (!existing) throw new NotFoundError('Member')

    const role = existing.role
    if (role === 'admin') {
      const admins = await tx
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.role, 'admin')
        ))
        .for('update')
      if (admins.length <= 1) throw new LastAdminError()
    }

    await tx
      .delete(workspaceMembers)
      .where(and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      ))
    return role
  })
}
