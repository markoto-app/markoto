import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import {
  activityLog,
  aiSessions,
  documentComments,
  documents,
  themes,
  users,
  workspaceMembers,
  workspaces
} from '../db/schema'
import { useDatabase } from '../db/client'
import type { SystemActor, UserScope, WorkspaceAccess } from './proofs'

// Repo helpers used only by the account-deletion executor. Kept apart from
// the other repos because they bypass invariants (>=1 admin, real owner) that
// `workspaceMembers.ts` etc. enforce; "remove last admin" next to the safe
// `removeMember` would be a foot-gun.
//
// None of these check authorisation; the executor reads the deletion plan first.

/**
 * Anonymise every comment authored by `userId` (`author_id` NULL, `author_name`
 * the literal `[deleted user]`). Returns rows updated. The placeholder is not
 * localised so the stored data stays locale-agnostic.
 */
export async function anonymiseCommentsByAuthor(user: UserScope): Promise<number> {
  const userId = user.userId
  const db = useDatabase()
  const updated = await db
    .update(documentComments)
    .set({ authorId: null, authorName: '[deleted user]' })
    .where(eq(documentComments.authorId, userId))
    .returning({ docId: documentComments.docId })
  return updated.length
}

/**
 * Anonymise the user's Activity Log rows on surviving documents.
 * `activity_log.user_id` is ON DELETE SET NULL, but the `user_name` snapshot
 * would still show the name; nulling it renders "Anonymous". Must run BEFORE
 * the users row is deleted.
 */
export async function anonymiseActivityByUser(user: UserScope): Promise<number> {
  const userId = user.userId
  const db = useDatabase()
  const updated = await db
    .update(activityLog)
    .set({ userName: null })
    .where(eq(activityLog.userId, userId))
    .returning({ id: activityLog.id })
  return updated.length
}

/**
 * Hard-delete every membership of the user and return the workspace ids. Run
 * after per-workspace promotion, so each workspace either keeps another admin
 * or is itself being cascade-deleted.
 */
export async function removeAllMemberships(user: UserScope): Promise<string[]> {
  const userId = user.userId
  const db = useDatabase()
  const removed = await db
    .delete(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .returning({ workspaceId: workspaceMembers.workspaceId })
  return removed.map(r => r.workspaceId)
}

/**
 * Promote a replacement admin: set `workspaces.owner_id` to the new admin (if
 * the user owned it) and make them admin. One transaction so a failure never
 * leaves a workspace without a path to an admin.
 */
export async function promoteWorkspaceAdmin(
  ws: WorkspaceAccess<'admin'>,
  outgoingUserId: number,
  newAdminUserId: number
): Promise<void> {
  const workspaceId = ws.workspaceId
  const db = useDatabase()
  await db.transaction(async (tx) => {
    // `workspaces.owner_id` is RESTRICT; it must be repointed before the user
    // row can be deleted.
    await tx
      .update(workspaces)
      .set({ ownerId: newAdminUserId })
      .where(and(
        eq(workspaces.workspaceId, workspaceId),
        eq(workspaces.ownerId, outgoingUserId)
      ))

    // Not via setRole(): it enforces the >=1-admin invariant this step exists
    // to satisfy.
    await tx
      .update(workspaceMembers)
      .set({ role: 'admin' })
      .where(and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, newAdminUserId)
      ))
  })
}

/**
 * Hard-delete every doc owned by the user and return the ids. The caller runs
 * `deleteDocument()` per id for the S3 + Y.js + sync side effects.
 */
export async function listOwnedDocIds(user: UserScope): Promise<string[]> {
  const userId = user.userId
  const db = useDatabase()
  const rows = await db
    .select({ docId: documents.docId })
    .from(documents)
    .where(eq(documents.ownerId, userId))
  return rows.map(r => r.docId)
}

/**
 * Delete `ai_sessions` initiated by the user. The FK is RESTRICT, so this must
 * precede the user-row delete (`ai_session_messages` cascades on user_id).
 */
export async function deleteAiSessionsByUser(user: UserScope): Promise<number> {
  const userId = user.userId
  const db = useDatabase()
  const removed = await db
    .delete(aiSessions)
    .where(eq(aiSessions.initiatorUserId, userId))
    .returning({ sessionId: aiSessions.sessionId })
  return removed.length
}

/**
 * Delete saved themes owned by the user. The FK already cascades; this is
 * explicit so the executor can count them for the audit summary and control
 * ordering.
 */
export async function deleteThemesByUser(user: UserScope): Promise<number> {
  const userId = user.userId
  const db = useDatabase()
  const removed = await db
    .delete(themes)
    .where(eq(themes.userId, userId))
    .returning({ themeId: themes.themeId })
  return removed.length
}

/**
 * Final gate: DELETE FROM users. Every RESTRICT reference must be gone first:
 * workspaces.owner_id (repointed or workspace cascaded), documents.owner_id
 * (docs deleted), ai_sessions.initiator_user_id (rows deleted). Other FKs
 * cascade or set null; ai_session_provenance cascades, so that user's AI edits
 * on surviving docs count as foreign for the taint gate.
 *
 * Throws if the user row no longer exists (another instance raced the sweeper
 * despite the advisory lock).
 */
export async function deleteUserRow(user: UserScope): Promise<void> {
  const userId = user.userId
  const db = useDatabase()
  const removed = await db
    .delete(users)
    .where(eq(users.id, userId))
    .returning({ id: users.id })
  if (removed.length === 0) {
    throw new Error(`deleteUserRow: user ${userId} already gone, possible double-execution`)
  }
}

/** Workspace ids the user belongs to, with role and the workspace's current owner. */
export interface UserMembershipRow {
  workspaceId: string
  // `guest`: the deletion plan just removes the membership.
  role: 'admin' | 'editor' | 'viewer' | 'guest'
  ownerId: number
  name: string
}

export async function listMembershipsForUser(user: UserScope): Promise<UserMembershipRow[]> {
  const userId = user.userId
  const db = useDatabase()
  const rows = await db
    .select({
      workspaceId: workspaceMembers.workspaceId,
      role: workspaceMembers.role,
      ownerId: workspaces.ownerId,
      name: workspaces.name
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.workspaceId, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
  return rows.map(r => ({
    workspaceId: r.workspaceId,
    role: r.role,
    ownerId: r.ownerId,
    name: r.name
  }))
}

/**
 * Other members ordered by tenure (joinedAt ASC), excluding the deleting user.
 * Empty means the workspace is sole-member.
 */
export async function listOtherMembers(
  ws: WorkspaceAccess<'member'>,
  excludeUserId: number
): Promise<{ userId: number, role: 'admin' | 'editor' | 'viewer' | 'guest', joinedAt: Date }[]> {
  const workspaceId = ws.workspaceId
  const db = useDatabase()
  const rows = await db
    .select({
      userId: workspaceMembers.userId,
      role: workspaceMembers.role,
      joinedAt: workspaceMembers.joinedAt
    })
    .from(workspaceMembers)
    .where(and(
      eq(workspaceMembers.workspaceId, workspaceId),
      sql`${workspaceMembers.userId} <> ${excludeUserId}`,
      // Guests are not the team: never promoted, and a workspace left with
      // only guests is deleted with its last member.
      ne(workspaceMembers.role, 'guest')
    ))
    .orderBy(workspaceMembers.joinedAt)
  return rows.map(r => ({
    userId: r.userId,
    role: r.role,
    joinedAt: r.joinedAt
  }))
}

/** Document ids in the given workspaces, for the cascade-delete of sole-member workspaces. */
export async function listDocIdsInWorkspaces(_by: SystemActor, workspaceIds: string[]): Promise<string[]> {
  if (workspaceIds.length === 0) return []
  const db = useDatabase()
  const rows = await db
    .select({ docId: documents.docId })
    .from(documents)
    .where(inArray(documents.workspaceId, workspaceIds))
  return rows.map(r => r.docId)
}
