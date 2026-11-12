import { must } from '~~/shared/utils/must'
import {
  countAccountRecords,
  countCommentsOnOthersDocs,
  countWorkspaceContents,
  getDeletionSubject,
  listCoMembers,
  listMembershipsForDeletion,
  listOwnedDocsForDeletion
} from '../../repos/accountDeletionPreview'
import type { UserScope } from '../../repos/proofs'

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
export async function planAccountDeletion(user: UserScope): Promise<AccountDeletionPlan | null> {
  const userId = user.userId
  // Bail early if the user is gone.
  const userRow = await getDeletionSubject(user)
  if (!userRow) return null

  const owned = await listOwnedDocsForDeletion(user)
  // Comments authored elsewhere (excluding comments on owned docs; those go
  // away with the doc anyway).
  const commentsToAnonymise = await countCommentsOnOthersDocs(user, owned.map(d => d.docId))
  const memberships = await listMembershipsForDeletion(user)

  const workspacesPlan: WorkspaceFate[] = []
  for (const m of memberships) {
    // Other members ordered by joinedAt ascending (longest-tenured first).
    // Filter out the deleting user. We need name + previous role for
    // the promote case, so join users.
    // Other members, longest-tenured first (name + previous role for the promote case).
    const others = await listCoMembers(user, m.workspaceId)

    if (others.length === 0) {
      // Sole member → cascade-delete the workspace + everything in it.
      const contents = await countWorkspaceContents(user, m.workspaceId)
      workspacesPlan.push({
        kind: 'cascade_delete',
        workspaceId: m.workspaceId,
        name: m.wsName,
        docCount: contents.docCount,
        knowledgeCount: contents.knowledgeCount
      })
    } else if (m.role === 'admin') {
      // User is admin (and there are other members). Promote the
      // longest-tenured non-user member. Prefer existing admin (no
      // role change needed); else promote the longest-tenured editor;
      // else longest-tenured viewer.
      const promote = others.find(o => o.role === 'admin')
        ?? others.find(o => o.role === 'editor')
        ?? must(others[0], 'another member (sole-member workspaces cascade above)')
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

  // AI usage, export jobs (their S3 blobs need cleanup) and the rows that
  // survive anonymised: counts for transparency.
  const records = await countAccountRecords(user)

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
    aiSessionsToDelete: records.aiSessions,
    aiSessionMessagesToDelete: records.aiSessionMessages,
    dataExportJobsToDelete: records.exportJobs.map(j => ({ jobId: j.jobId, s3Key: j.s3Key })),
    stripeCustomerToDelete: userRow.stripeCustomerId,
    rowsRetainedAnonymised: {
      activityLog: records.activityLog,
      auditLog: records.auditLog,
      consentLog: records.consentLog
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
