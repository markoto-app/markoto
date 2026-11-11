import { and, eq, ne, sql } from 'drizzle-orm'
import {
  aiSessions,
  aiSessionMessages,
  dataExportJobs,
  documentComments,
  documents,
  themes,
  users,
  workspaceMembers,
  workspaces
} from '../../db/schema'
import { useDatabase } from '../platform/database'

/**
 * Build a Postgres ARRAY literal of the user's owned doc ids. Inline
 * single-quote escaping (PG-standard `''`) is safe here because
 * `documents.doc_id` is a system-controlled `nanoid(10)` (alphanum
 * only) — but we keep the escape for parity with hand-typed values
 * a future migration might allow.
 */
function buildDocIdArrayLiteral(ownedDocIds: string[]): string {
  const escaped = ownedDocIds.map(id => `'${id.replaceAll('\'', '\'\'')}'`)
  return `ARRAY[${escaped.join(',')}]::text[]`
}

// Pre-computes — and exposes for transparent UX — the consequences of
// deleting a user's account. The same module is used by:
//
//   1. `/api/user/me/deletion-preview` (GET) — surfaces the plan to
//      the user BEFORE they confirm. Drives the consequence modal in
//      `/settings/profile`.
//   2. `accountDeletionExecute.ts` — re-reads the plan inside the
//      sweeper at execution time. The preview is informational; state
//      may have drifted between request + execute (the user could
//      have been promoted in a workspace, their docs could have been
//      moved, etc.) so we never trust a snapshot.
//
// The plan is intentionally a *description* — no side effects. It
// states what each affected entity will become and (for ambiguous
// cases like workspace promotion) names the receiving party so the
// confirm modal can show "Bob will become admin of Engineering".

export type WorkspaceFate
  /** User is sole member; cascade-delete the workspace + all its docs + knowledge. */
  = | { kind: 'cascade_delete', workspaceId: string, name: string, docCount: number, knowledgeCount: number }
  /** User is admin/owner with co-members; promote the longest-tenured non-user member. */
    | { kind: 'promote_admin', workspaceId: string, name: string, newAdminUserId: number, newAdminName: string, newAdminPreviousRole: 'admin' | 'editor' | 'viewer' | 'guest' }
  /** User is a non-admin member; just remove their membership row. */
    | { kind: 'remove_member', workspaceId: string, name: string, currentRole: 'admin' | 'editor' | 'viewer' | 'guest' }

export interface AccountDeletionPlan {
  userId: number
  // Personally-attributable data the user owns outright.
  ownedDocs: { docId: string, title: string, accessMode: string, workspaceId: string | null }[]
  // Comments authored on docs the user does NOT own — these get
  // anonymised, not deleted, by policy.
  commentsToAnonymise: number
  // Workspaces the user is a member of, with the per-workspace fate.
  workspaces: WorkspaceFate[]
  // Counts only — these go away wholesale, no per-row decisions.
  aiSessionsToDelete: number
  aiSessionMessagesToDelete: number
  // Data-export jobs hold S3 blobs we need to clean up.
  dataExportJobsToDelete: { jobId: string, s3Key: string | null }[]
  // Stripe customer to delete (if billing was set up). Not personal
  // data per se but disclosed for transparency.
  stripeCustomerToDelete: string | null
  // Records that survive (anonymised). Surfaced in the preview so the
  // user understands the scope.
  rowsRetainedAnonymised: {
    activityLog: number
    auditLog: number
    consentLog: number
  }
}

/**
 * Compute the plan for a given user. Returns `null` if the user does
 * not exist (so the preview endpoint can 404 cleanly).
 */
export async function planAccountDeletion(userId: number): Promise<AccountDeletionPlan | null> {
  const db = useDatabase()

  // Bail early if the user is gone.
  const userRow = (await db
    .select({ id: users.id, stripeCustomerId: users.stripeCustomerId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1))[0]
  if (!userRow) return null

  // ── Owned docs ──────────────────────────────────────────────────
  const owned = await db
    .select({
      docId: documents.docId,
      title: documents.title,
      accessMode: documents.accessMode,
      workspaceId: documents.workspaceId
    })
    .from(documents)
    .where(eq(documents.ownerId, userId))

  // ── Comments authored elsewhere (excluding comments on owned docs;
  //    those go away with the doc anyway) ──────────────────────────
  const ownedDocIds = owned.map(d => d.docId)
  const commentsCountRows = ownedDocIds.length === 0
    ? await db
        .select({ count: sql<number>`count(*)::int` })
        .from(documentComments)
        .where(eq(documentComments.authorId, userId))
    : await db
        .select({ count: sql<number>`count(*)::int` })
        .from(documentComments)
        .where(and(
          eq(documentComments.authorId, userId),
          sql`${documentComments.docId} <> ALL (${sql.raw(buildDocIdArrayLiteral(ownedDocIds))})`
        ))
  const commentsToAnonymise = Number(commentsCountRows[0]?.count ?? 0)

  // ── Workspaces ──────────────────────────────────────────────────
  const memberships = await db
    .select({
      workspaceId: workspaceMembers.workspaceId,
      role: workspaceMembers.role,
      ownerId: workspaces.ownerId,
      wsName: workspaces.name
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.workspaceId, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))

  const workspacesPlan: WorkspaceFate[] = []
  for (const m of memberships) {
    // Other members ordered by joinedAt ascending (longest-tenured first).
    // Filter out the deleting user. We need name + previous role for
    // the promote case, so join users.
    const others = await db
      .select({
        userId: workspaceMembers.userId,
        role: workspaceMembers.role,
        joinedAt: workspaceMembers.joinedAt,
        name: users.name
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(and(
        eq(workspaceMembers.workspaceId, m.workspaceId),
        sql`${workspaceMembers.userId} <> ${userId}`,
        // Guests are not the team: never promoted, and a workspace
        // left with only guests counts as having no other member.
        ne(workspaceMembers.role, 'guest')
      ))
      .orderBy(workspaceMembers.joinedAt)

    if (others.length === 0) {
      // Sole member → cascade-delete the workspace + everything in it.
      const docCountRow = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(documents)
        .where(eq(documents.workspaceId, m.workspaceId))
      const knowledgeCountRow = await db.execute<{ count: number }>(sql`
        SELECT COUNT(*)::int AS count FROM workspace_knowledge WHERE workspace_id = ${m.workspaceId}
      `)
      workspacesPlan.push({
        kind: 'cascade_delete',
        workspaceId: m.workspaceId,
        name: m.wsName,
        docCount: Number(docCountRow[0]?.count ?? 0),
        knowledgeCount: Number(knowledgeCountRow.rows?.[0]?.count ?? 0)
      })
    } else if (m.role === 'admin') {
      // User is admin (and there are other members). Promote the
      // longest-tenured non-user member. Prefer existing admin (no
      // role change needed); else promote the longest-tenured editor;
      // else longest-tenured viewer.
      const promote = others.find(o => o.role === 'admin')
        ?? others.find(o => o.role === 'editor')
        ?? others[0]!
      workspacesPlan.push({
        kind: 'promote_admin',
        workspaceId: m.workspaceId,
        name: m.wsName,
        newAdminUserId: promote.userId,
        newAdminName: promote.name,
        newAdminPreviousRole: promote.role
      })
    } else {
      // User is editor or viewer — nothing structural to do beyond
      // removing their membership row.
      workspacesPlan.push({
        kind: 'remove_member',
        workspaceId: m.workspaceId,
        name: m.wsName,
        currentRole: m.role
      })
    }
  }

  // ── AI usage (cascade via FK, but expose counts for transparency) ─
  const aiSessionsRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(aiSessions)
    .where(eq(aiSessions.initiatorUserId, userId))
  const aiSessionMessagesRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(aiSessionMessages)
    .where(eq(aiSessionMessages.userId, userId))
  // ── Data export jobs (CASCADE on user delete, but the S3 blobs
  //    don't go away with the row — collect keys for cleanup) ──────
  const exportJobs = await db
    .select({ jobId: dataExportJobs.jobId, s3Key: dataExportJobs.s3Key })
    .from(dataExportJobs)
    .where(eq(dataExportJobs.userId, userId))

  // ── Activity / audit / consent surviving counts (transparency) ──
  const activityCountRow = await db.execute<{ count: number }>(sql`
    SELECT COUNT(*)::int AS count FROM activity_log WHERE user_id = ${userId}
  `)
  const auditCountRow = await db.execute<{ count: number }>(sql`
    SELECT COUNT(*)::int AS count FROM audit_log WHERE actor_user_id = ${userId}
  `)
  const consentCountRow = await db.execute<{ count: number }>(sql`
    SELECT COUNT(*)::int AS count FROM consent_log WHERE user_id = ${userId}
  `)

  return {
    userId,
    ownedDocs: owned.map(d => ({
      docId: d.docId,
      title: d.title,
      accessMode: d.accessMode,
      workspaceId: d.workspaceId
    })),
    commentsToAnonymise,
    workspaces: workspacesPlan,
    aiSessionsToDelete: Number(aiSessionsRows[0]?.count ?? 0),
    aiSessionMessagesToDelete: Number(aiSessionMessagesRows[0]?.count ?? 0),
    dataExportJobsToDelete: exportJobs.map(j => ({ jobId: j.jobId, s3Key: j.s3Key })),
    stripeCustomerToDelete: userRow.stripeCustomerId,
    rowsRetainedAnonymised: {
      activityLog: Number(activityCountRow.rows?.[0]?.count ?? 0),
      auditLog: Number(auditCountRow.rows?.[0]?.count ?? 0),
      consentLog: Number(consentCountRow.rows?.[0]?.count ?? 0)
    }
  }
}

// Convenience: tiny summary used by audit-log metadata after
// execution. Not the same shape as the user-facing preview.
export interface AccountDeletionSummary {
  ownedDocsDeleted: number
  workspacesCascadeDeleted: number
  workspacesPromoted: number
  workspaceMembershipsRemoved: number
  commentsAnonymised: number
  /** Activity Log rows whose name snapshot was cleared. */
  activityAnonymised: number
  aiSessionsDeleted: number
  aiSessionMessagesDeleted: number
  dataExportJobsDeleted: number
  stripeCustomerDeleted: boolean
  /** LiteLLM virtual key + LiteLLM user record removed (best effort). */
  litellmKeyDeleted: boolean
  themesDeleted: number
  /** BYOK provider configs (incl. encrypted API keys) removed. */
  aiProvidersDeleted: number
  /** Open workspace invitations addressed to the user's email. */
  workspaceInvitesDeleted: number
  /** Team / Business subscriptions whose billing-admin role passed on (or ended). */
  billingAdminHandovers: number
  /** The user's keys in workspace LiteLLM teams. */
  workspaceKeysDeleted: number
  /** Personal AI credit top-ups. */
  creditGrantsDeleted: number
}

// Theme count for the executor; not in the preview because saved themes
// are personal and always go away with the account.
export async function countThemesByUser(userId: number): Promise<number> {
  const db = useDatabase()
  const rows = await db.select({ count: sql<number>`count(*)::int` })
    .from(themes)
    .where(eq(themes.userId, userId))
  return Number(rows[0]?.count ?? 0)
}
