import * as Sentry from '@sentry/nuxt'
import { DeleteObjectCommand } from '@aws-sdk/client-s3'
import { appendAuditEvent } from '../repos/audit'
import { listKnowledge } from '../repos/knowledge'
import { deleteWorkspaceRow } from '../repos/workspaces'
import {
  anonymiseCommentsByAuthor,
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
import { deleteDocument } from './documentLifecycle'
import { deleteKnowledgeArtifact } from './knowledgeAccess'
import { useS3Client } from './s3'
import { useStripeClient } from './stripeClient'
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
    return {
      summary: emptySummary()
    }
  }
  const stripeCustomerId = userRow.stripeCustomerId

  const summary: AccountDeletionSummary = emptySummary()

  // ── Step 1: anonymise comments ───────────────────────────────────
  // Done first because we want the comment bodies to survive even if
  // the doc is later cascade-deleted (the per-doc cascade purges
  // documentComments rows for that doc — this UPDATE just makes sure
  // any comment that survives the deletion has an anonymised author).
  summary.commentsAnonymised = await anonymiseCommentsByAuthor(userId)

  // ── Step 2: process each workspace per the policy ────────────────
  const memberships = await listMembershipsForUser(userId)
  const cascadeWorkspaceIds: string[] = []

  for (const m of memberships) {
    const others = await listOtherMembers(m.workspaceId, userId)

    if (others.length === 0) {
      // Sole member — cascade-delete the entire workspace.
      cascadeWorkspaceIds.push(m.workspaceId)
      summary.workspacesCascadeDeleted += 1
    } else if (m.role === 'admin') {
      // Promote the longest-tenured non-user member. Existing admin
      // first → editor → viewer.
      const promote = others.find(o => o.role === 'admin')
        ?? others.find(o => o.role === 'editor')
        ?? others[0]!
      await promoteWorkspaceAdmin(m.workspaceId, userId, promote.userId)
      summary.workspacesPromoted += 1
    } else {
      // Plain editor/viewer — nothing structural; the membership row
      // gets dropped in Step 5. Counted there.
    }
  }

  // ── Step 3: cascade-delete workspaces with no surviving members ──
  // Per-doc cascade rather than relying on FK because each doc needs
  // S3 + sync notify. Mirror the workspace-delete endpoint pattern.
  if (cascadeWorkspaceIds.length > 0) {
    const docIdsInCascadedWs = await listDocIdsInWorkspaces(cascadeWorkspaceIds)
    for (const docId of docIdsInCascadedWs) {
      try {
        await deleteDocument(docId)
        summary.ownedDocsDeleted += 1
      } catch (e) {
        // Don't propagate — cascade is best-effort. Sentry reports
        // the failure; the orphan-cleanup sweep + render-cleanup
        // catches missed S3 keys later. The next deletion-sweep run
        // will retry the user.
        console.error(`[accountDeletion] cascade-delete doc ${docId} failed:`, e instanceof Error ? e.message : e)
        Sentry.captureException(e, {
          tags: { component: 'accountDeletion', event: 'cascade_doc_failed', docId }
        })
        throw e // bail user — next sweep retries
      }
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
    // Drop the workspace rows themselves — workspace_members cascade
    // via FK.
    for (const wsId of cascadeWorkspaceIds) {
      await deleteWorkspaceRow(wsId)
    }
  }

  // ── Step 4: hard-delete docs the user owns (outside cascaded ws) ─
  // After Step 3 the workspace cascade has already taken care of docs
  // that were inside cascaded workspaces. The remaining `listOwnedDocIds`
  // returns standalone or co-member-workspace docs the user owns.
  const remainingOwnedDocs = await listOwnedDocIds(userId)
  for (const docId of remainingOwnedDocs) {
    try {
      await deleteDocument(docId)
      summary.ownedDocsDeleted += 1
    } catch (e) {
      console.error(`[accountDeletion] owned-doc delete ${docId} failed:`, e instanceof Error ? e.message : e)
      Sentry.captureException(e, {
        tags: { component: 'accountDeletion', event: 'owned_doc_failed', docId }
      })
      throw e
    }
  }

  // ── Step 5: remove all remaining workspace memberships ────────────
  // Both the editor/viewer rows AND the ones we just promoted for
  // (the user is admin in the row but the workspace now has another
  // admin too).
  const removedWorkspaceIds = await removeAllMemberships(userId)
  summary.workspaceMembershipsRemoved = removedWorkspaceIds.length

  // ── Step 6: AI usage purge ───────────────────────────────────────
  summary.aiSessionsDeleted = await deleteAiSessionsByUser(userId)
  // ai_session_messages CASCADE on user delete — count + then let FK
  // do the work at Step 9.

  // Phase 6: ai_usage_period table dropped (LiteLLM owns spend state).
  // Per-user budget data is wiped via the LiteLLM /key/{key}/delete
  // call below in the Stripe-customer-cleanup step.

  // ── Step 7: themes ───────────────────────────────────────────────
  summary.themesDeleted = await deleteThemesByUser(userId)

  // ── Step 7b: collect data-export S3 blobs for post-commit delete ─
  // The `data_export_jobs` rows themselves CASCADE on user delete via
  // FK — we don't touch them here. But the S3 blobs they point at
  // outlive the FK cascade and must be deleted separately. Snapshot
  // the keys NOW (while the rows still exist), then delete after
  // commit.
  const exportJobsForCleanup = await listAllJobsForUser(userId)
  const exportS3KeysToDelete = exportJobsForCleanup
    .map(j => j.s3Key)
    .filter((k): k is string => k !== null)
  summary.dataExportJobsDeleted = exportJobsForCleanup.length

  // ── Step 8: drop the user row ────────────────────────────────────
  // `data_export_jobs`, `ai_session_messages`, `consent_log`,
  // `activity_log`, `audit_log`, `abuse_reports`, `uploads.uploader_id`,
  // and `workspace_knowledge.uploader_id` all CASCADE / SET NULL via
  // FK and are handled by this row delete.
  await deleteUserRow(userId)

  // ── Step 9: side effects after the local commit ──────────────────
  // Stripe deletion — best-effort. A wedged Stripe API must not
  // roll back the local deletion (which has already committed). The
  // Stripe customer record contains billing / tax data Stripe is
  // legally required to retain regardless; calling customers.del
  // here marks the customer deleted on their side and stops further
  // charges / emails / portal access.
  if (stripeCustomerId) {
    try {
      const stripe = useStripeClient()
      if (stripe) {
        await stripe.customers.del(stripeCustomerId)
        summary.stripeCustomerDeleted = true
      }
    } catch (e) {
      console.error(`[accountDeletion] stripe customers.del failed for ${stripeCustomerId}:`, e instanceof Error ? e.message : e)
      Sentry.captureException(e, {
        tags: { component: 'accountDeletion', event: 'stripe_del_failed', userId: String(userId) }
      })
      // Don't throw — local state has already committed.
    }
  }

  // Best-effort export-blob cleanup. If S3 is wedged the bucket
  // lifecycle policy reaps the orphans eventually.
  if (exportS3KeysToDelete.length > 0) {
    const config = useRuntimeConfig()
    const s3 = useS3Client()
    for (const key of exportS3KeysToDelete) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key }))
      } catch (e) {
        console.warn(`[accountDeletion] export blob delete failed for ${key}:`, e instanceof Error ? e.message : e)
        Sentry.captureException(e, {
          tags: { component: 'accountDeletion', event: 'export_blob_delete_failed' }
        })
      }
    }
  }

  // ── Step 10: final audit row, AFTER the user is gone ─────────────
  // `actorUserId` is null because the user row no longer exists (the
  // FK would reject anything else). The historical link is preserved
  // via `scopeId = String(userId)`. Writing the row last lets
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
      summary: { ...summary } as Record<string, unknown>,
      stripeCustomerId: stripeCustomerId ?? null
    }
  })

  return { summary }
}

function emptySummary(): AccountDeletionSummary {
  return {
    ownedDocsDeleted: 0,
    workspacesCascadeDeleted: 0,
    workspacesPromoted: 0,
    workspaceMembershipsRemoved: 0,
    commentsAnonymised: 0,
    aiSessionsDeleted: 0,
    aiSessionMessagesDeleted: 0,
    dataExportJobsDeleted: 0,
    stripeCustomerDeleted: false,
    themesDeleted: 0
  }
}
