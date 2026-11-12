import { must } from '~~/shared/utils/must'
import * as Sentry from '@sentry/nuxt'
import { DeleteObjectCommand } from '@aws-sdk/client-s3'
import { appendAuditEvent } from '../../repos/audit'
import { listKnowledge } from '../../repos/knowledge'
import { deleteWorkspaceRow } from '../../repos/workspaces'
import { collectBrandObjectKeys, deleteBrandObjects } from '../brandKit/storage'
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
} from '../../repos/accountDeletionRepo'
import { listAllJobsForUser } from '../../repos/dataExportJobs'
import { findUserById } from '../../repos/users'
import { deleteAllAiProvidersForUser } from '../../repos/aiProviders'
import { deleteUserKey } from '../litellm/userKeys'
import { deleteInvitesForEmail } from '../../repos/workspaceInvites'
import { normaliseInviteEmail } from '../workspaces/workspaceInvites'
import { deleteDocument } from '../documents/documentLifecycle'
import { deleteKnowledgeArtifact } from '../knowledge/knowledgeAccess'
import { useS3Client } from '../storage/s3'
import { useStripeClient } from '../billing/stripeClient'
import { isBillingEnabled } from '../billing/billingMode'
import { AUDIT_ACCOUNT_DELETE_EXECUTED } from '../../legal/auditActions'
import type { AccountDeletionSummary } from './accountDeletionPlan'
import { deleteAllMemberKeys, endWorkspaceBilling, handOverBillingAdmin } from '../billing/workspaceBillingLifecycle'
import { deleteCreditsForSubject } from '../../repos/aiCreditGrants'
import { useEnv } from '~~/shared/env/load'
import { useLogger } from '../platform/logger'
import { system, type UserScope } from '../../repos/proofs'

const log = useLogger('account-deletion')

// Cascading account deletion executor. Policy:
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
//   - Owned docs are HARD-DELETED regardless of collaborators.
//   - AI sessions + messages hard-deleted.
//   - Data-export jobs hard-deleted; their S3 blobs cleaned up.
//   - LiteLLM virtual key + LiteLLM user record DELETED (best effort).
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

/**
 * The deletion job acts on everything the account holds: its own rows
 * (`user`), the workspaces it leaves or takes down, its documents.
 */
const JOB = system('account-deletion')

export async function executeAccountDeletion(
  args: ExecuteAccountDeletionArgs
): Promise<ExecuteAccountDeletionResult> {
  const userId = args.userId
  const user = JOB.user(userId)

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

  summary.commentsAnonymised = await anonymiseCommentsByAuthor(user)
  summary.activityAnonymised = await anonymiseActivityByUser(user)
  const cascadeWorkspaceIds = await processWorkspaceMemberships(user, summary)
  // Team / Business: billing-admin role → longest-serving other
  // admin (after the promotion above), else the subscription ends at the
  // period end. Cascade-deleted workspaces cancel instead.
  summary.billingAdminHandovers = await handOverBillingAdmin(JOB, userId, cascadeWorkspaceIds)
  await cascadeDeleteWorkspaces(cascadeWorkspaceIds, summary)
  await deleteOwnedDocs(user, summary)

  // The user's keys in workspace LiteLLM teams (the tokens live on the
  // membership rows, so before they go).
  summary.workspaceKeysDeleted = await deleteAllMemberKeys(userId)
  // Personal AI credit top-ups (no FK to users).
  summary.creditGrantsDeleted = await deleteCreditsForSubject({ type: 'user', id: String(userId) })
  const removed = await removeAllMemberships(user)
  summary.workspaceMembershipsRemoved = removed.length

  summary.aiSessionsDeleted = await deleteAiSessionsByUser(user)
  summary.themesDeleted = await deleteThemesByUser(user)
  // BYOK provider configs hold third-party API keys (encrypted). The FK
  // CASCADE would drop them with the user row anyway; deleting
  // explicitly makes the count visible in the audit summary.
  summary.aiProvidersDeleted = await deleteAllAiProvidersForUser(user)
  // Pending invitations addressed to the user's email (someone else
  // typed the address; the person is leaving, so it goes). Invites the
  // user SENT keep existing for their workspace; `invited_by_user_id`
  // is SET NULL by the FK with the user row.
  const inviteEmail = normaliseInviteEmail(userRow.email)
  summary.workspaceInvitesDeleted = inviteEmail === null ? 0 : await deleteInvitesForEmail(JOB, inviteEmail)

  const exportS3KeysToDelete = await collectExportS3Keys(user, summary)

  // LiteLLM virtual key + user record. Before the row delete: the
  // encrypted key token lives on the users row. Best effort, never
  // throws (a proxy outage must not block the erasure).
  summary.litellmKeyDeleted = await deleteUserKey(userId)

  // ── Drop the user row ────────────────────────────────────────────
  // `data_export_jobs`, `ai_session_messages`, `consent_log`,
  // `activity_log`, `audit_log`, `abuse_reports`, `uploads.uploader_id`,
  // and `workspace_knowledge.uploader_id` all CASCADE / SET NULL via
  // FK and are handled by this row delete.
  await deleteUserRow(user)

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
    by: JOB,
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
  user: UserScope,
  summary: AccountDeletionSummary
): Promise<string[]> {
  const userId = user.userId
  const memberships = await listMembershipsForUser(user)
  const cascadeWorkspaceIds: string[] = []

  for (const m of memberships) {
    const others = await listOtherMembers(JOB.workspace(m.workspaceId), userId)
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
      ?? must(others[0], 'another member (sole-member workspaces cascade above)')
    await promoteWorkspaceAdmin(JOB.workspace(m.workspaceId), userId, promote.userId)
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
  // Team / Business: cancel every subscription FIRST. A
  // subscription Stripe won't cancel throws here, before anything of
  // these workspaces is deleted; the sweep retries the account later.
  for (const wsId of cascadeWorkspaceIds) {
    await endWorkspaceBilling(JOB.workspace(wsId))
  }
  const docIds = await listDocIdsInWorkspaces(JOB, cascadeWorkspaceIds)
  for (const docId of docIds) {
    await deleteOneDoc(docId, 'cascade_doc_failed', summary)
  }
  // Knowledge cleanup — per-row S3 delete; the workspace_knowledge
  // FK cascades the DB rows when the workspace row is dropped, but
  // the original S3 objects are usually already gone (deleted post-
  // processing). `deleteKnowledgeArtifact` tolerates 404.
  for (const wsId of cascadeWorkspaceIds) {
    const ws = JOB.workspace(wsId)
    const knowledgeRows = await listKnowledge(ws)
    for (const row of knowledgeRows) {
      await deleteKnowledgeArtifact(ws, row.knowledgeId)
    }
  }
  // Drop the workspace rows themselves — workspace_members cascade via FK.
  // Brand-kit objects: keys read before the rows cascade away.
  for (const wsId of cascadeWorkspaceIds) {
    const ws = JOB.workspace(wsId)
    const brandKeys = await collectBrandObjectKeys(ws)
    await deleteWorkspaceRow(ws)
    await deleteBrandObjects(brandKeys)
  }
}

/**
 * Hard-delete remaining docs the user owns (outside cascaded
 * workspaces). After cascadeDeleteWorkspaces these are standalone or
 * co-member-workspace docs.
 */
async function deleteOwnedDocs(user: UserScope, summary: AccountDeletionSummary): Promise<void> {
  const remaining = await listOwnedDocIds(user)
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
    await deleteDocument(JOB.doc(docId))
    summary.ownedDocsDeleted += 1
  } catch (e) {
    log.error('document cleanup failed', { step: sentryEvent, docId, err: e })
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
async function collectExportS3Keys(user: UserScope, summary: AccountDeletionSummary): Promise<string[]> {
  const jobs = await listAllJobsForUser(user)
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
    log.error('stripe customers.del failed', { stripeCustomerId, err: e })
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
  const bucket = useEnv().storage.bucket
  const s3 = useS3Client()
  for (const key of keys) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    } catch (e) {
      log.warn('export blob delete failed', { key, err: e })
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
    litellmKeyDeleted: false,
    themesDeleted: 0,
    aiProvidersDeleted: 0,
    workspaceInvitesDeleted: 0,
    billingAdminHandovers: 0,
    workspaceKeysDeleted: 0,
    creditGrantsDeleted: 0
  }
}
