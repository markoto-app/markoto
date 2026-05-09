import { and, eq, inArray, sql } from 'drizzle-orm'
import {
  aiSessions,
  documentComments,
  documents,
  themes,
  users,
  workspaceMembers,
  workspaces
} from '../db/schema'
import { useDatabase } from '../utils/database'

// Repo helpers used exclusively by the account-deletion executor.
// Lives in its own file rather than spread across the existing repos
// because:
//
//   1. The membership / workspace / document layers each enforce
//      invariants ("≥1 admin", "owner is a real user") that we MUST
//      bypass during deletion. Putting "remove last admin without
//      checks" in `workspaceMembers.ts` next to the safe `removeMember`
//      would be a foot-gun for any future caller.
//   2. The cascade is one-shot at end-of-grace; co-locating its odd
//      mutations here keeps the audit footprint of the deletion path
//      a single file to grep for.
//
// **None of these functions check authorisation.** They trust the
// caller (the executor) to have read the deletion plan first.

/**
 * Anonymise every comment row authored by `userId`. Sets `author_id`
 * to NULL and `author_name` to the literal `[deleted user]` string.
 * Returns the number of rows updated.
 *
 * The `[deleted user]` placeholder is intentionally NOT localised —
 * the row is read by every viewer regardless of locale, and the UI
 * layer can translate the literal at render time if we choose to
 * later. Storing a single canonical placeholder keeps the database
 * locale-agnostic.
 */
export async function anonymiseCommentsByAuthor(userId: number): Promise<number> {
  const db = useDatabase()
  const updated = await db
    .update(documentComments)
    .set({ authorId: null, authorName: '[deleted user]' })
    .where(eq(documentComments.authorId, userId))
    .returning({ docId: documentComments.docId })
  return updated.length
}

/**
 * Hard-delete every membership row for the given user across all
 * workspaces. Returns the workspace ids the user was a member of so
 * the caller can run any workspace-level audit logging it needs.
 *
 * Safe to call AFTER the per-workspace promotion step has run — by
 * that point every workspace either still has another admin (so
 * removing this row is fine) or is itself about to be cascade-deleted.
 */
export async function removeAllMemberships(userId: number): Promise<string[]> {
  const db = useDatabase()
  const removed = await db
    .delete(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .returning({ workspaceId: workspaceMembers.workspaceId })
  return removed.map(r => r.workspaceId)
}

/**
 * For workspaces where the user is admin AND there are co-members,
 * promote a chosen replacement. Two effects:
 *   1. UPDATE workspaces SET owner_id = newAdminUserId (if user was
 *      the row's owner; otherwise no-op on this column).
 *   2. UPDATE workspace_members SET role='admin' for the new admin
 *      (idempotent if they were already admin).
 *
 * Both happen in a single transaction so a failure mid-way doesn't
 * leave a workspace with no path to admin.
 */
export async function promoteWorkspaceAdmin(
  workspaceId: string,
  outgoingUserId: number,
  newAdminUserId: number
): Promise<void> {
  const db = useDatabase()
  await db.transaction(async (tx) => {
    // Repoint provenance ownership if the outgoing user is currently
    // the workspaces.owner_id. The schema FK has no onDelete clause
    // (defaults to RESTRICT), so leaving owner_id pointing at a
    // soon-to-be-deleted user would block the user-row delete.
    await tx
      .update(workspaces)
      .set({ ownerId: newAdminUserId })
      .where(and(
        eq(workspaces.workspaceId, workspaceId),
        eq(workspaces.ownerId, outgoingUserId)
      ))

    // Promote (or no-op if already admin). We don't go through
    // setRole() because that enforces the ≥1-admin invariant we are
    // here to satisfy, not maintain.
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
 * Hard-delete every doc owned by the user. Returns the list of
 * doc ids so the caller can run `deleteDocument()` post-DB to cascade
 * S3 + Y.js + sync notify.
 *
 * Note: this DOES NOT call `deleteDocument()` itself. The orchestration
 * layer is responsible for the per-doc S3 + sync side-effects. This
 * function just returns the doc ids that need to be reaped.
 */
export async function listOwnedDocIds(userId: number): Promise<string[]> {
  const db = useDatabase()
  const rows = await db
    .select({ docId: documents.docId })
    .from(documents)
    .where(eq(documents.ownerId, userId))
  return rows.map(r => r.docId)
}

/**
 * Delete every `ai_sessions` row whose initiator is the given user.
 * The schema FK is RESTRICT (no onDelete clause), so we MUST do this
 * explicitly before deleting the user row — otherwise the final
 * DELETE FROM users would error.
 *
 * `ai_session_messages` is FK CASCADE on user_id, so those rows go
 * away with the user row automatically. We don't touch that table
 * here.
 */
export async function deleteAiSessionsByUser(userId: number): Promise<number> {
  const db = useDatabase()
  const removed = await db
    .delete(aiSessions)
    .where(eq(aiSessions.initiatorUserId, userId))
    .returning({ sessionId: aiSessions.sessionId })
  return removed.length
}

/**
/**
 * Delete saved themes owned by the user. The FK already cascades on
 * user delete, but we expose this explicitly so the executor can:
 *   (a) count the number for the audit summary; and
 *   (b) be explicit about the order of operations rather than
 *       relying on FK-side-effect timing for an explicit user action.
 */
export async function deleteThemesByUser(userId: number): Promise<number> {
  const db = useDatabase()
  const removed = await db
    .delete(themes)
    .where(eq(themes.userId, userId))
    .returning({ themeId: themes.themeId })
  return removed.length
}

/**
 * Final gate: DELETE FROM users WHERE id = $1. By this point every
 * blocking FK reference must have been cleaned up:
 *
 *   - workspaces.owner_id (RESTRICT)         → repointed by promote
 *                                                 OR workspace cascaded
 *   - documents.owner_id (RESTRICT)          → docs hard-deleted
 *   - ai_sessions.initiator_user_id (RESTRICT) → rows deleted
 *
 * Other FKs auto-cascade or set-null:
 *   - activity_log.user_id (SET NULL)
 *   - audit_log.actor_user_id (SET NULL)
 *   - consent_log.user_id (SET NULL)
 *   - workspace_members.user_id (CASCADE) — but we delete explicitly
 *                                            for an audit count
 *   - data_export_jobs.user_id (CASCADE)
 *   - ai_session_messages.user_id (CASCADE)
 *   - themes.user_id (CASCADE) — explicit for audit count
 *   - uploads.uploader_id (SET NULL)
 *   - documents.workspace_id is set null on workspace delete via FK
 *   - workspace_knowledge.uploader_id (SET NULL)
 *   - abuse_reports.actioned_by (SET NULL)
 *
 * Throws if the user row no longer exists — indicates the sweeper
 * is racing another instance, which the advisory lock should
 * already have prevented.
 */
export async function deleteUserRow(userId: number): Promise<void> {
  const db = useDatabase()
  const removed = await db
    .delete(users)
    .where(eq(users.id, userId))
    .returning({ id: users.id })
  if (removed.length === 0) {
    throw new Error(`deleteUserRow: user ${userId} already gone — possible double-execution`)
  }
}

/**
 * Read the list of workspace ids the user is a member of, with their
 * role + the workspace's current owner. Used by the executor to drive
 * the per-workspace decision tree.
 */
export interface UserMembershipRow {
  workspaceId: string
  role: 'admin' | 'editor' | 'viewer'
  ownerId: number
  name: string
}

export async function listMembershipsForUser(userId: number): Promise<UserMembershipRow[]> {
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
 * For the per-workspace promotion: list other members ordered by
 * tenure (joinedAt ASC). Excludes the deleting user. Empty array
 * means the workspace is sole-member.
 */
export async function listOtherMembers(
  workspaceId: string,
  excludeUserId: number
): Promise<{ userId: number, role: 'admin' | 'editor' | 'viewer', joinedAt: Date }[]> {
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
      sql`${workspaceMembers.userId} <> ${excludeUserId}`
    ))
    .orderBy(workspaceMembers.joinedAt)
  return rows.map(r => ({
    userId: r.userId,
    role: r.role,
    joinedAt: r.joinedAt
  }))
}

/**
 * Bulk-list document ids in a set of workspace ids. Used by the
 * cascade-delete branch (sole-member workspace) to enumerate docs to
 * deleteDocument() per-row.
 */
export async function listDocIdsInWorkspaces(workspaceIds: string[]): Promise<string[]> {
  if (workspaceIds.length === 0) return []
  const db = useDatabase()
  const rows = await db
    .select({ docId: documents.docId })
    .from(documents)
    .where(inArray(documents.workspaceId, workspaceIds))
  return rows.map(r => r.docId)
}
