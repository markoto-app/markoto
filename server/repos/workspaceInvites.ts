import { and, asc, count, eq, gt, lte, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { users, workspaceInvites, workspaceMembers, workspaces } from '../db/schema'
import type { MembershipRole } from '../../shared/utils/documents/docPermissions'
import { useDatabase } from '../utils/platform/database'

// `workspace_invites` repository — pending workspace invitations.
//
// Lifecycle:
//   invite      → row upserted per (workspace, email); re-inviting the
//                 same address refreshes role / inviter / expiry / token
//   accept      → member row inserted (no-op if already a member) and
//                 the invite deleted, in ONE transaction
//   decline     → invite deleted
//   revoke      → invite deleted by a workspace admin
//   sweep       → expired invites deleted
//   account deletion → invites addressed to the user's email deleted;
//                 `invited_by_user_id` SET NULL via FK
//
// Emails arrive normalised (`normaliseInviteEmail`). Token values arrive
// HASHED (`hashInviteSecret`) — the raw token never reaches this layer.
// Every lookup that takes an externally supplied invite id is keyed on a
// tuple (invite id + workspace for admins, invite id + email for the
// invitee) so one workspace's / person's ids can't reach another's rows.

export interface UpsertInviteInput {
  workspaceId: string
  email: string
  role: MembershipRole
  invitedByUserId: number
  tokenHash: string | null
  expiresAt: Date
}

/** Admin view of an open invite — the typed address, never account data. */
export interface WorkspaceInviteAdminRow {
  inviteId: string
  email: string
  role: MembershipRole
  invitedByName: string | null
  createdAt: Date
  expiresAt: Date
}

/** Invitee view of an invite addressed to them. */
export interface WorkspaceInviteInboxRow {
  inviteId: string
  workspaceId: string
  workspaceName: string
  role: MembershipRole
  invitedByName: string | null
  createdAt: Date
  expiresAt: Date
}

/**
 * Create or refresh the open invite for (workspace, email). Returns the
 * invite id. A refresh rotates the token (an earlier emailed link stops
 * working) and restarts the expiry.
 */
export async function upsertWorkspaceInvite(input: UpsertInviteInput): Promise<string> {
  const db = useDatabase()
  const row = (await db
    .insert(workspaceInvites)
    .values({
      inviteId: nanoid(16),
      workspaceId: input.workspaceId,
      email: input.email,
      role: input.role,
      invitedByUserId: input.invitedByUserId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt
    })
    .onConflictDoUpdate({
      target: [workspaceInvites.workspaceId, workspaceInvites.email],
      set: {
        role: input.role,
        invitedByUserId: input.invitedByUserId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        createdAt: sql`now()`
      }
    })
    .returning({ inviteId: workspaceInvites.inviteId }))[0]
  if (!row) throw new Error('upsertWorkspaceInvite: no row returned')
  return row.inviteId
}

/** Open (unexpired) invites of a workspace, excluding `exceptEmail`. */
export async function countOpenWorkspaceInvites(
  workspaceId: string,
  now: Date,
  exceptEmail?: string,
  // `members` for seats + the member limit, `guests` for the guest cap,
  // `all` for the open-invitation cap.
  kind: 'all' | 'members' | 'guests' = 'all'
): Promise<number> {
  const db = useDatabase()
  const conditions = [eq(workspaceInvites.workspaceId, workspaceId), gt(workspaceInvites.expiresAt, now)]
  if (exceptEmail !== undefined) conditions.push(sql`${workspaceInvites.email} <> ${exceptEmail}`)
  if (kind === 'members') conditions.push(sql`${workspaceInvites.role} <> 'guest'`)
  if (kind === 'guests') conditions.push(sql`${workspaceInvites.role} = 'guest'`)
  const row = (await db.select({ n: count() }).from(workspaceInvites).where(and(...conditions)))[0]
  return row?.n ?? 0
}

/** Is a user with this (normalised) email already a member of the workspace? */
export async function isEmailWorkspaceMember(workspaceId: string, email: string): Promise<boolean> {
  const db = useDatabase()
  const row = (await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(
      eq(workspaceMembers.workspaceId, workspaceId),
      sql`lower(${users.email}) = ${email}`
    ))
    .limit(1))[0]
  return row !== undefined
}

/** Open invites of a workspace, for its admins. */
export async function listWorkspaceInvites(workspaceId: string, now: Date): Promise<WorkspaceInviteAdminRow[]> {
  const db = useDatabase()
  return db
    .select({
      inviteId: workspaceInvites.inviteId,
      email: workspaceInvites.email,
      role: workspaceInvites.role,
      invitedByName: users.name,
      createdAt: workspaceInvites.createdAt,
      expiresAt: workspaceInvites.expiresAt
    })
    .from(workspaceInvites)
    .leftJoin(users, eq(users.id, workspaceInvites.invitedByUserId))
    .where(and(eq(workspaceInvites.workspaceId, workspaceId), gt(workspaceInvites.expiresAt, now)))
    .orderBy(asc(workspaceInvites.createdAt))
}

/** Revoke an invite. Keyed on (workspace, invite id). Null when nothing matched. */
export async function deleteWorkspaceInvite(workspaceId: string, inviteId: string): Promise<{ role: MembershipRole } | null> {
  const db = useDatabase()
  const row = (await db
    .delete(workspaceInvites)
    .where(and(eq(workspaceInvites.workspaceId, workspaceId), eq(workspaceInvites.inviteId, inviteId)))
    .returning({ role: workspaceInvites.role }))[0]
  return row ?? null
}

/** Open invites addressed to an email (the invitee's inbox). */
export async function listInvitesForEmail(email: string, now: Date): Promise<WorkspaceInviteInboxRow[]> {
  const db = useDatabase()
  return db
    .select({
      inviteId: workspaceInvites.inviteId,
      workspaceId: workspaceInvites.workspaceId,
      workspaceName: workspaces.name,
      role: workspaceInvites.role,
      invitedByName: users.name,
      createdAt: workspaceInvites.createdAt,
      expiresAt: workspaceInvites.expiresAt
    })
    .from(workspaceInvites)
    .innerJoin(workspaces, eq(workspaces.workspaceId, workspaceInvites.workspaceId))
    .leftJoin(users, eq(users.id, workspaceInvites.invitedByUserId))
    .where(and(eq(workspaceInvites.email, email), gt(workspaceInvites.expiresAt, now)))
    .orderBy(asc(workspaceInvites.createdAt))
}

/** How the invitee proves the invite is theirs. */
export type InviteSelector
  = | { kind: 'id', inviteId: string, email: string }
    | { kind: 'token', tokenHash: string }

export interface ResolvedInvite {
  inviteId: string
  workspaceId: string
  workspaceName: string
  role: MembershipRole
}

function selectorCondition(selector: InviteSelector) {
  return selector.kind === 'id'
    ? and(eq(workspaceInvites.inviteId, selector.inviteId), eq(workspaceInvites.email, selector.email))
    : eq(workspaceInvites.tokenHash, selector.tokenHash)
}

/**
 * Accept an open invite: insert the membership (keeping an existing
 * membership and its role untouched) and delete the invite, atomically.
 * The invite row is locked first so two concurrent accepts can't both
 * act on it. Null when no open invite matches.
 */
export async function acceptWorkspaceInvite(
  selector: InviteSelector,
  userId: number,
  now: Date
): Promise<(ResolvedInvite & { alreadyMember: boolean }) | null> {
  const db = useDatabase()
  return await db.transaction(async (tx) => {
    const invite = (await tx
      .select({
        id: workspaceInvites.id,
        inviteId: workspaceInvites.inviteId,
        workspaceId: workspaceInvites.workspaceId,
        role: workspaceInvites.role,
        expiresAt: workspaceInvites.expiresAt
      })
      .from(workspaceInvites)
      .where(selectorCondition(selector))
      .for('update')
      .limit(1))[0]
    if (!invite || invite.expiresAt.getTime() <= now.getTime()) return null

    const inserted = await tx
      .insert(workspaceMembers)
      .values({ workspaceId: invite.workspaceId, userId, role: invite.role })
      .onConflictDoNothing({ target: [workspaceMembers.workspaceId, workspaceMembers.userId] })
      .returning({ userId: workspaceMembers.userId })
    await tx.delete(workspaceInvites).where(eq(workspaceInvites.id, invite.id))

    const ws = (await tx
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.workspaceId, invite.workspaceId))
      .limit(1))[0]
    return {
      inviteId: invite.inviteId,
      workspaceId: invite.workspaceId,
      workspaceName: ws?.name ?? '',
      role: invite.role,
      alreadyMember: inserted.length === 0
    }
  })
}

/** Decline (delete) an open or expired invite. Null when none matched. */
export async function declineWorkspaceInvite(selector: InviteSelector): Promise<{ inviteId: string, workspaceId: string } | null> {
  const db = useDatabase()
  const row = (await db
    .delete(workspaceInvites)
    .where(selectorCondition(selector))
    .returning({ inviteId: workspaceInvites.inviteId, workspaceId: workspaceInvites.workspaceId }))[0]
  return row ?? null
}

/** Sweeper: delete invites past their expiry. Returns the number deleted. */
export async function deleteExpiredWorkspaceInvites(now: Date): Promise<number> {
  const db = useDatabase()
  const rows = await db
    .delete(workspaceInvites)
    .where(lte(workspaceInvites.expiresAt, now))
    .returning({ id: workspaceInvites.id })
  return rows.length
}

/** Account deletion: drop every invite addressed to this email. */
export async function deleteInvitesForEmail(email: string): Promise<number> {
  const db = useDatabase()
  const rows = await db
    .delete(workspaceInvites)
    .where(eq(workspaceInvites.email, email))
    .returning({ id: workspaceInvites.id })
  return rows.length
}

/** Data export: invites addressed to the user and invites they sent. */
export async function listInvitesForExport(userId: number, email: string | null): Promise<{
  received: Array<{ workspaceName: string, role: MembershipRole, createdAt: Date, expiresAt: Date }>
  sent: Array<{ workspaceId: string, email: string, role: MembershipRole, createdAt: Date, expiresAt: Date }>
}> {
  const db = useDatabase()
  const received = email === null
    ? []
    : await db
        .select({
          workspaceName: workspaces.name,
          role: workspaceInvites.role,
          createdAt: workspaceInvites.createdAt,
          expiresAt: workspaceInvites.expiresAt
        })
        .from(workspaceInvites)
        .innerJoin(workspaces, eq(workspaces.workspaceId, workspaceInvites.workspaceId))
        .where(eq(workspaceInvites.email, email))
        .orderBy(asc(workspaceInvites.createdAt))
  const sent = await db
    .select({
      workspaceId: workspaceInvites.workspaceId,
      email: workspaceInvites.email,
      role: workspaceInvites.role,
      createdAt: workspaceInvites.createdAt,
      expiresAt: workspaceInvites.expiresAt
    })
    .from(workspaceInvites)
    .where(eq(workspaceInvites.invitedByUserId, userId))
    .orderBy(asc(workspaceInvites.createdAt))
  return { received, sent }
}
