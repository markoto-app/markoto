import { and, asc, eq, ne, sql } from 'drizzle-orm'
import { documents, workspaceMembers, users } from '../db/schema'
import type { MembershipRole, WorkspaceRole } from '../../shared/utils/documents/docPermissions'
import { useDatabase } from '../db/client'
import { ConflictError, LastAdminError, NotFoundError } from './errors'
import type { DocAccess, UserScope, WorkspaceAccess } from './proofs'

// Workspace-membership repository. This table is the authorisation source
// of truth for workspaces; every mutation here needs to preserve the
// "≥1 admin" invariant, which is why several of these functions are
// transactional or do their own count-then-mutate bookkeeping.

/** setRole on a guest: invite them as a member instead. */
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
  /** `guest` included: the member list shows guests too. */
  role: MembershipRole
  joinedAt: Date
}

/**
 * Full member roster for a workspace, ordered admin → editor → viewer,
 * then by joinedAt ascending within each role.
 */
export async function listMembers(ws: WorkspaceAccess<'member'>): Promise<MemberRow[]> {
  const workspaceId = ws.workspaceId
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
 * Roster for the presence bar, joined with the doc's ownerId so the UI
 * can render an "owner" badge. Same ordering as listMembers().
 */
export async function listMembersForDoc(doc: DocAccess<'view'>): Promise<Array<{
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
      isDocOwner: sql<boolean>`coalesce(${users.id} = ${docColumn('owner_id', doc)}, false)`
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    // The document's own workspace; guests aren't part of the team roster
    // (presence, mentions).
    .where(and(eq(workspaceMembers.workspaceId, sql`${docColumn('workspace_id', doc)}`), ne(workspaceMembers.role, 'guest')))
    .orderBy(sql`case ${workspaceMembers.role} when 'admin' then 0 when 'editor' then 1 else 2 end, ${workspaceMembers.joinedAt} asc`) as Promise<Array<{ userId: number, name: string, login: string | null, role: WorkspaceRole, isDocOwner: boolean }>>
}

/**
 * How many admins does this workspace have right now? Used to enforce
 * the last-admin invariant before demotion / removal.
 */
export async function countAdmins(ws: WorkspaceAccess<'member'>): Promise<number> {
  const workspaceId = ws.workspaceId
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
export async function countMembers(ws: WorkspaceAccess<'member'>): Promise<number> {
  const workspaceId = ws.workspaceId
  const db = useDatabase()
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(workspaceMembers)
    // Guests take no seat and don't count towards the member limit.
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), ne(workspaceMembers.role, 'guest')))
  return rows[0]?.n ?? 0
}

/** Guests of the workspace, for the guest cap. */
export async function countGuests(ws: WorkspaceAccess<'member'>): Promise<number> {
  const workspaceId = ws.workspaceId
  const rows = await useDatabase()
    .select({ n: sql<number>`count(*)::int` })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, 'guest')))
  return rows[0]?.n ?? 0
}

/**
 * Insert a new member. Does NOT check whether the caller is allowed to,
 * endpoints gate admin-only via getMemberRole beforehand. Does check
 * duplicate insertion and throws ConflictError via the schema-level PK.
 */
export async function addMember(
  ws: WorkspaceAccess<'admin'>,
  userId: number,
  role: WorkspaceRole
): Promise<void> {
  const workspaceId = ws.workspaceId
  const db = useDatabase()
  await db.insert(workspaceMembers).values({ workspaceId, userId, role })
}

/**
 * Change a member's role. Enforces the >=1-admin invariant: refuses to demote
 * the last admin. Returns the previous role; throws NotFoundError if the user
 * isn't a member.
 *
 * Runs in a transaction and takes `FOR UPDATE` on every admin row during the
 * count. Without it two concurrent demotions both read admin_count=2 under
 * READ COMMITTED and both commit, leaving zero admins; the lock makes the
 * second block and then see the post-demotion state (LastAdminError). Do not
 * remove it.
 */
export async function setRole(
  ws: WorkspaceAccess<'admin'>,
  userId: number,
  nextRole: WorkspaceRole
): Promise<WorkspaceRole> {
  const workspaceId = ws.workspaceId
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
    // A guest becomes a member only through an invitation (which
    // checks seats); there is no role change into or out of `guest`.
    if (prev === 'guest') throw new GuestRoleChangeError()
    if (prev === 'admin' && nextRole !== 'admin') {
      // Lock every admin row in this workspace, concurrent demotions
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
 * Remove a member. Enforces the ≥1-admin invariant, if the target is
 * the last admin, refuses. Same FOR UPDATE lock story as setRole.
 * Returns the removed role, or throws NotFoundError.
 */
export async function removeMember(ws: WorkspaceAccess<'admin'>, userId: number): Promise<MembershipRole> {
  return removeMembership(ws.workspaceId, userId)
}

/**
 * The caller leaves a workspace (members and guests alike); same invariant
 * as `removeMember`. Returns the ids of the workspace's documents too, whose
 * open connections of the leaver the caller closes.
 */
export async function leaveWorkspace(self: UserScope, workspaceId: string): Promise<{ role: MembershipRole, workspaceDocIds: string[] }> {
  const role = await removeMembership(workspaceId, self.userId)
  const docs = await useDatabase().select({ docId: documents.docId }).from(documents).where(eq(documents.workspaceId, workspaceId))
  return { role, workspaceDocIds: docs.map(d => d.docId) }
}

/** A column of the proof's document row, as a scalar subquery. */
function docColumn(column: 'owner_id' | 'workspace_id', doc: DocAccess) {
  return sql`(select ${sql.identifier(column)} from ${documents} where ${documents.docId} = ${doc.docId})`
}

async function removeMembership(workspaceId: string, userId: number): Promise<MembershipRole> {
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

/** The guests of the document's workspace (whom its sharers can share it with). */
export async function listGuestsForDoc(doc: DocAccess<'share'>): Promise<Array<{ userId: number, name: string, email: string | null }>> {
  return useDatabase()
    .select({ userId: users.id, name: users.name, email: users.email })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(workspaceMembers.workspaceId, sql`${docColumn('workspace_id', doc)}`), eq(workspaceMembers.role, 'guest')))
    .orderBy(sql`${workspaceMembers.joinedAt} asc`)
}

/** The longest-serving admin of the workspace other than `excludeUserId` (billing-admin hand-over). */
export async function findLongestServingOtherAdmin(ws: WorkspaceAccess<'admin'>, excludeUserId: number): Promise<number | null> {
  const row = (await useDatabase()
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, ws.workspaceId), eq(workspaceMembers.role, 'admin'), ne(workspaceMembers.userId, excludeUserId)))
    .orderBy(asc(workspaceMembers.joinedAt))
    .limit(1))[0]
  return row?.userId ?? null
}
