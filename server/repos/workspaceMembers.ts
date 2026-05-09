import { and, eq, sql } from 'drizzle-orm'
import { workspaceMembers, users } from '../db/schema'
import type { WorkspaceRole } from '../../shared/utils/docPermissions'
import { useDatabase } from '../utils/database'
import { LastAdminError, NotFoundError } from './errors'

// Workspace-membership repository. This table is the authorisation source
// of truth for workspaces; every mutation here needs to preserve the
// "≥1 admin" invariant, which is why several of these functions are
// transactional or do their own count-then-mutate bookkeeping.

export interface MemberRow {
  userId: number
  name: string
  email: string | null
  login: string | null
  avatarUrl: string | null
  role: WorkspaceRole
  joinedAt: Date
}

/**
 * The caller's role in a workspace, or null if not a member.
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
      eq(workspaceMembers.userId, userId)
    ))
    .limit(1))[0]
  return (row?.role ?? null)
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
      avatarUrl: users.avatarUrl,
      role: workspaceMembers.role,
      joinedAt: workspaceMembers.joinedAt
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .orderBy(sql`case ${workspaceMembers.role} when 'admin' then 0 when 'editor' then 1 else 2 end, ${workspaceMembers.joinedAt} asc`) as Promise<MemberRow[]>
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
  avatarUrl: string | null
  login: string | null
  role: WorkspaceRole
  isDocOwner: boolean
}>> {
  const db = useDatabase()
  return db
    .select({
      userId: users.id,
      name: users.name,
      avatarUrl: users.avatarUrl,
      login: users.login,
      role: workspaceMembers.role,
      isDocOwner: sql<boolean>`${users.id} = ${docOwnerId}`
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .orderBy(sql`case ${workspaceMembers.role} when 'admin' then 0 when 'editor' then 1 else 2 end, ${workspaceMembers.joinedAt} asc`) as Promise<Array<{
    userId: number
    name: string
    avatarUrl: string | null
    login: string | null
    role: WorkspaceRole
    isDocOwner: boolean
  }>>
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

    const prev = existing.role
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
): Promise<WorkspaceRole> {
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
