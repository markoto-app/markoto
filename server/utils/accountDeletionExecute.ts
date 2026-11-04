import * as Sentry from '@sentry/nuxt'
import { DeleteObjectCommand } from '@aws-sdk/client-s3'
import { appendAuditEvent } from '../repos/audit'
import { listKnowledge } from '../repos/knowledge'
import { deleteWorkspaceRow } from '../repos/workspaces'
import {
  anonymiseCommentsByAuthor,
  anonymiseActivityByUser,
  deleteAiSessionsByUser,
  deleteThemesByUser,
  deleteUserRow,
  listDocIdsInWorkspaces,
  listMembershipsForUser,
  listOtherMembers,
  listOwnedDocIds,
  promoteWorkspaceAdmin,
  removeAllMemberships
} from '../repos/accountDeletionRepo'
import { listAllJobsForUser } from '../repos/dataExportJobs'
import { findUserById } from '../repos/users'
import { deleteAllAiProvidersForUser } from '../repos/aiProviders'
import { deleteInvitesForEmail } from '../repos/workspaceInvites'
import { normaliseInviteEmail } from './workspaceInvites'
import { deleteDocument } from './documentLifecycle'
import { deleteKnowledgeArtifact } from './knowledgeAccess'
import { useS3Client } from './s3'
import { useStripeClient } from './stripeClient'
import { isBillingEnabled } from './billingMode'
import { AUDIT_ACCOUNT_DELETE_EXECUTED } from '../legal/auditActions'
import type { AccountDeletionSummary } from './accountDeletionPlan'

// Cascading account deletion executor. Implements the locked policy:
//
//   - Comments authored by the user are ANONYMISED (author_id = NULL,
//     author_name = '[deleted user]'); the bodies are kept so other
//     participants don't lose context.
//   - Workspaces where the user is admin:
//       * sole member → cascade-delete the workspace + every doc + every
//                       knowledge file.
//       * co-admin / has co-members → promote the longest-tenured
//         non-user member (preferring an existing admin → editor →
//         viewer) and remove the user's membership row.
//   - Workspaces where the user is editor/viewer → just remove the
//     membership row.
//   - Owned docs are HARD-DELETED regardless of collaborators (per
//     the agreed policy).
//   - AI usage (sessions + messages + period rows) hard-deleted.
//   - Data-export jobs hard-deleted; their S3 blobs cleaned up.
//   - Stripe customer DELETED via stripe.customers.del — Stripe's
//     own legal-retention policy then governs the underlying records.
//   - consent_log / activity_log / audit_log / abuse_reports rows
//     SURVIVE with their user-id columns SET NULL (FK-driven). The
//     audit_log entry recording THIS deletion lands BEFORE the user
//     row goes so the actor link is preserved.
//
// Ordering is load-bearing — see the inline comments. The whole
// executor is idempotent at the row level: re-running on a partial
// state (e.g. some workspaces cascade-deleted, others not) picks up
// where it left off.

export interface ExecuteAccountDeletionArgs {
  userId: number
}

export interface ExecuteAccountDeletionResult {
  summary: AccountDeletionSummary
}

export async function executeAccountDeletion(
  args: ExecuteAccountDeletionArgs
): Promise<ExecuteAccountDeletionResult> {
  const userId = args.userId

  // Pre-read for the audit row + Stripe customer id. Read-then-act
  // is fine here — the advisory lock at the sweeper level has
  // serialised this user; nothing else mutates `users.stripeCustomerId`
  // mid-flight.
  const userRow = await findUserById(userId)
  if (!userRow) {
    // Already gone — treat as no-op success (idempotency).
    return { summary: emptySummary() }
  }
  const stripeCustomerId = userRow.stripeCustomerId
  const summary = emptySummary()

  summary.commentsAnonymised = await anonymiseCommentsByAuthor(userId)
  summary.activityAnonymised = await anonymiseActivityByUser(userId)
  const cascadeWorkspaceIds = await processWorkspaceMemberships(userId, summary)
  await cascadeDeleteWorkspaces(cascadeWorkspaceIds, summary)
  await deleteOwnedDocs(userId, summary)

  const removed = await removeAllMemberships(userId)
  summary.workspaceMembershipsRemoved = removed.length

  summary.aiSessionsDeleted = await deleteAiSessionsByUser(userId)
  summary.themesDeleted = await deleteThemesByUser(userId)
  // BYOK provider configs hold third-party API keys (encrypted). The FK
  // CASCADE would drop them with the user row anyway; deleting
  // explicitly makes the count visible in the audit summary.
  summary.aiProvidersDeleted = await deleteAllAiProvidersForUser(userId)
  // Pending invitations addressed to the user's email (someone else
  // typed the address; the person is leaving, so it goes). Invites the
  // user SENT keep existing for their workspace; `invited_by_user_id`
  // is SET NULL by the FK with the user row.
  const inviteEmail = normaliseInviteEmail(userRow.email)
  summary.workspaceInvitesDeleted = inviteEmail === null ? 0 : await deleteInvitesForEmail(inviteEmail)

  const exportS3KeysToDelete = await collectExportS3Keys(userId, summary)

  // ── Drop the user row ────────────────────────────────────────────
  // `data_export_jobs`, `ai_session_messages`, `consent_log`,
  // `activity_log`, `audit_log`, `abuse_reports`, `uploads.uploader_id`,
  // and `workspace_knowledge.uploader_id` all CASCADE / SET NULL via
  // FK and are handled by this row delete.
  await deleteUserRow(userId)

  // Side effects after the local commit. Stripe + S3 failures must not
  // roll back the local deletion (which has already committed).
  await deleteStripeCustomer(stripeCustomerId, userId, summary)
  await cleanupExportS3Blobs(exportS3KeysToDelete)

  // Final audit row, AFTER the user is gone. `actorUserId` is null
  // because the user row no longer exists (the FK would reject
  // anything else). The historical link is preserved via
  // `scopeId = String(userId)`. Writing the row last lets
  // `metadata.summary` carry the FINAL state — including the
  // post-Stripe `stripeCustomerDeleted` flag.
  await appendAuditEvent({
    actorUserId: null,
    actorIp: null,
    scope: 'user',
    scopeId: String(userId),
    action: AUDIT_ACCOUNT_DELETE_EXECUTED,
    before: null,
    after: null,
    metadata: {
      summary: { ...summary },
      stripeCustomerId: stripeCustomerId ?? null
    }
  })

  return { summary }
}

/**
 * Walk every workspace the user is in. For sole-member workspaces,
 * collect the id for cascade delete. For co-member workspaces where
 * the user is admin, promote the longest-tenured non-user member
 * (existing admin → editor → viewer). Plain editor/viewer rows are
 * left for the bulk membership-drop in `removeAllMemberships`.
 */
async function processWorkspaceMemberships(
  userId: number,
  summary: AccountDeletionSummary
): Promise<string[]> {
  const memberships = await listMembershipsForUser(userId)
  const cascadeWorkspaceIds: string[] = []

  for (const m of memberships) {
    const others = await listOtherMembers(m.workspaceId, userId)
    if (others.length === 0) {
      // Sole member — cascade-delete the entire workspace.
      cascadeWorkspaceIds.push(m.workspaceId)
      summary.workspacesCascadeDeleted += 1
      continue
    }
    if (m.role !== 'admin') continue

    // Promote the longest-tenured non-user member. Existing admin
    // first → editor → viewer.
    const promote = others.find(o => o.role === 'admin')
      ?? others.find(o => o.role === 'editor')
      ?? others[0]!
    await promoteWorkspaceAdmin(m.workspaceId, userId, promote.userId)
    summary.workspacesPromoted += 1
  }
  return cascadeWorkspaceIds
}

/**
 * Cascade-delete every doc + knowledge file in the given workspaces,
 * then drop the workspace rows. Per-doc cascade rather than relying on
 * FK because each doc needs S3 + sync notify; mirrors the workspace-
 * delete endpoint pattern.
 */
async function cascadeDeleteWorkspaces(
  cascadeWorkspaceIds: string[],
  summary: AccountDeletionSummary
): Promise<void> {
  if (cascadeWorkspaceIds.length === 0) return
  const docIds = await listDocIdsInWorkspaces(cascadeWorkspaceIds)
  for (const docId of docIds) {
    await deleteOneDoc(docId, 'cascade_doc_failed', summary)
  }
  // Knowledge cleanup — per-row S3 delete; the workspace_knowledge
  // FK cascades the DB rows when the workspace row is dropped, but
  // the original S3 objects are usually already gone (deleted post-
  // processing). `deleteKnowledgeArtifact` tolerates 404.
  for (const wsId of cascadeWorkspaceIds) {
    const knowledgeRows = await listKnowledge(wsId)
    for (const row of knowledgeRows) {
      await deleteKnowledgeArtifact(row.knowledgeId)
    }
  }
  // Drop the workspace rows themselves — workspace_members cascade via FK.
  for (const wsId of cascadeWorkspaceIds) {
    await deleteWorkspaceRow(wsId)
  }
}

/**
 * Hard-delete remaining docs the user owns (outside cascaded
 * workspaces). After cascadeDeleteWorkspaces these are standalone or
 * co-member-workspace docs.
 */
async function deleteOwnedDocs(userId: number, summary: AccountDeletionSummary): Promise<void> {
  const remaining = await listOwnedDocIds(userId)
  for (const docId of remaining) {
    await deleteOneDoc(docId, 'owned_doc_failed', summary)
  }
}

/**
 * Per-doc delete with shared error handling. Throws to bail the user
 * — the next deletion-sweep run will retry. Sentry captures the
 * specific event so dashboards distinguish cascade-cause from
 * owned-doc-cause failures.
 */
async function deleteOneDoc(docId: string, sentryEvent: string, summary: AccountDeletionSummary): Promise<void> {
  try {
    await deleteDocument(docId)
    summary.ownedDocsDeleted += 1
  } catch (e) {
    console.error(`[accountDeletion] ${sentryEvent} ${docId}:`, e instanceof Error ? e.message : e)
    Sentry.captureException(e, {
      tags: { component: 'accountDeletion', event: sentryEvent, docId }
    })
    throw e
  }
}

/**
 * Snapshot data-export S3 keys BEFORE the user row drops (the
 * data_export_jobs rows CASCADE via FK on user delete; we capture the
 * keys now so the post-commit S3 cleanup has somewhere to look).
 */
async function collectExportS3Keys(userId: number, summary: AccountDeletionSummary): Promise<string[]> {
  const jobs = await listAllJobsForUser(userId)
  summary.dataExportJobsDeleted = jobs.length
  return jobs
    .map(j => j.s3Key)
    .filter((k): k is string => k !== null)
}

/**
 * Best-effort Stripe customer delete. The customer record contains
 * billing / tax data Stripe is legally required to retain regardless;
 * calling customers.del marks the customer deleted on their side and
 * stops further charges / emails / portal access. A wedged Stripe API
 * doesn't roll back the local commit.
 */
async function deleteStripeCustomer(
  stripeCustomerId: string | null,
  userId: number,
  summary: AccountDeletionSummary
): Promise<void> {
  if (!stripeCustomerId) return
  // Billing off: Stripe isn't configured on this deployment, so there is
  // nothing we could call. Skip silently — no error, no Sentry noise.
  // (`stripeCustomerDeleted` stays false in the summary, which is true.)
  if (!isBillingEnabled()) return
  try {
    const stripe = useStripeClient()
    if (!stripe) return
    await stripe.customers.del(stripeCustomerId)
    summary.stripeCustomerDeleted = true
  } catch (e) {
    console.error(`[accountDeletion] stripe customers.del failed for ${stripeCustomerId}:`, e instanceof Error ? e.message : e)
    Sentry.captureException(e, {
      tags: { component: 'accountDeletion', event: 'stripe_del_failed', userId: String(userId) }
    })
  }
}

/**
 * Best-effort export-blob cleanup. If S3 is wedged the bucket
 * lifecycle policy reaps the orphans eventually.
 */
async function cleanupExportS3Blobs(keys: string[]): Promise<void> {
  if (keys.length === 0) return
  const bucket = useRuntimeConfig().s3.bucket
  const s3 = useS3Client()
  for (const key of keys) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    } catch (e) {
      console.warn(`[accountDeletion] export blob delete failed for ${key}:`, e instanceof Error ? e.message : e)
      Sentry.captureException(e, {
        tags: { component: 'accountDeletion', event: 'export_blob_delete_failed' }
      })
    }
  }
}

function emptySummary(): AccountDeletionSummary {
  return {
    ownedDocsDeleted: 0,
    workspacesCascadeDeleted: 0,
    workspacesPromoted: 0,
    workspaceMembershipsRemoved: 0,
    commentsAnonymised: 0,
    activityAnonymised: 0,
    aiSessionsDeleted: 0,
    aiSessionMessagesDeleted: 0,
    dataExportJobsDeleted: 0,
    stripeCustomerDeleted: false,
    themesDeleted: 0,
    aiProvidersDeleted: 0,
    workspaceInvitesDeleted: 0
  }
}
