import { eq } from 'drizzle-orm'
import {
  countWorkspaceKnowledge,
  sumWorkspaceKnowledgeBytes,
  countKnowledgeByUploader,
  sumKnowledgeBytesByUploader
} from '../repos/knowledge'
import { users, workspaces } from '../db/schema'
import { useDatabase } from './database'
import { reserveInflightSlot, releaseInflightSlot } from './rateLimit'
import { KNOWLEDGE_PLATFORM_LIMITS, type PlanName } from '~~/shared/config/tiers'
import { getTiers } from '~~/server/utils/tierConfig'
import { effectivePlan, limitRecovery } from '~~/server/utils/billingMode'

/**
 * Centralised cap enforcement for the workspace knowledge base.
 *
 * Two enforcement points:
 *   - Pre-upload (on upload-request): cheap DB count + bytes check, plus
 *     a Valkey inflight slot reservation so concurrent upload-requests
 *     for the same workspace can't all pass the "N-1 of N used" check
 *     and collectively overshoot.
 *   - Pre-confirm: re-check the DB counts inside a transaction + advisory
 *     lock in the caller so a pair of uploads that both squeaked past
 *     the upload-request check (e.g. Valkey flaked) can't both commit.
 *
 * Raised errors are `createError` so callers can just let them bubble;
 * status codes match the semantic meaning (413 file-size, 409 cap,
 * 429 rate-limit).
 */

// Inflight slot TTL. Matches the presigned-URL TTL (300s) plus a small
// safety margin so that an abandoned upload-request (user never PUTs)
// frees its slot after the URL is useless anyway. The presigned TTL is
// 300s from S3 signing — 360s here covers clock skew + the confirm
// roundtrip on the happy path.
const INFLIGHT_SLOT_TTL_MS = 360 * 1000

// Namespaces for the inflight counters. Keep them stable — they key
// into Valkey under `inflight:{namespace}:{key}`, so renaming would
// orphan live counters in production.
export const INFLIGHT_NS_WORKSPACE = 'knowledge-upload-ws'
export const INFLIGHT_NS_USER = 'knowledge-upload-user'

export interface KnowledgeCaps {
  maxFileBytes: number
  maxFilesPerWorkspace: number
  maxTotalBytesPerWorkspace: number
  maxFilesPerUser: number
  maxTotalBytesPerUser: number
  /** Plan whose caps we're using for the per-workspace portion. Diagnostic only. */
  workspacePlan: PlanName
  /** Plan whose caps we're using for the per-user portion. Diagnostic only. */
  uploaderPlan: PlanName
}

async function getEffectivePlan(userId: number | null): Promise<PlanName> {
  if (userId === null) return 'free'
  const db = useDatabase()
  const rows = await db.select({
    plan: users.plan,
    planValidUntil: users.planValidUntil
  }).from(users).where(eq(users.id, userId)).limit(1)
  const row = rows[0]
  if (!row) return 'free'
  // Lapsed paid plans AND billing-off deployments both resolve to free.
  return effectivePlan(row.plan, row.planValidUntil)
}

/**
 * Resolve the tier whose per-workspace caps apply to this workspace's
 * knowledge base. If `(+)` team-billing is active and the billing
 * owner's plan is still valid → use the billing owner's plan. Else
 * fall back to the workspace creator's plan.
 *
 * If the creator's account has also lapsed (or was deleted), we end up
 * at `free` — the most restrictive option — which is correct: we don't
 * want an abandoned Max workspace to retain 10 GB of storage room
 * indefinitely after the creator stopped paying.
 */
async function getWorkspacePlan(workspaceId: string): Promise<PlanName> {
  const db = useDatabase()
  const rows = await db.select({
    ownerId: workspaces.ownerId,
    billingOwnerId: workspaces.billingOwnerId,
    aiEnabled: workspaces.aiEnabled
  }).from(workspaces).where(eq(workspaces.workspaceId, workspaceId)).limit(1)
  const ws = rows[0]
  if (!ws) return 'free'

  if (ws.aiEnabled && ws.billingOwnerId !== null) {
    const ownerPlan = await getEffectivePlan(ws.billingOwnerId)
    // `(+)` with a pro/free billing owner (e.g. owner downgraded and
    // sweep hasn't run) defensively falls through to the creator.
    // Pro is personal-only; only max/ultra can team-bill.
    if (ownerPlan === 'max' || ownerPlan === 'ultra') return ownerPlan
  }
  return await getEffectivePlan(ws.ownerId)
}

/**
 * Resolve the full cap set for an upload. Per-workspace caps read the
 * workspace's effective plan (billing owner if `(+)`, else creator);
 * per-user caps read the uploader's own plan. `maxFileBytes` is a
 * platform constant (markitdown conversion throughput + S3
 * single-part upload ceiling), not a tier knob.
 */
export async function resolveCaps(args: {
  workspaceId: string
  uploaderId: number
}): Promise<KnowledgeCaps> {
  const [uploaderPlan, workspacePlan] = await Promise.all([
    getEffectivePlan(args.uploaderId),
    getWorkspacePlan(args.workspaceId)
  ])
  const tiers = getTiers()
  const wsTier = tiers[workspacePlan]
  const userTier = tiers[uploaderPlan]
  return {
    maxFileBytes: KNOWLEDGE_PLATFORM_LIMITS.maxFileBytes,
    maxFilesPerWorkspace: wsTier.knowledgeFiles,
    maxTotalBytesPerWorkspace: wsTier.knowledgeBytesPerWorkspace,
    maxFilesPerUser: userTier.knowledgeFiles,
    maxTotalBytesPerUser: userTier.knowledgeBytesPerUser,
    workspacePlan,
    uploaderPlan
  }
}

/**
 * Pre-upload gate. Checks file-size + both workspace and per-user caps
 * against the DB, and reserves inflight slots at both scopes. Releases
 * slots automatically on failure; the caller must release them on
 * subsequent failure paths (e.g. S3 presign throws).
 *
 * Returns a releaser the caller should invoke on any failure AFTER
 * the presign succeeds. On successful confirm, call `releaseSlots`
 * in the confirm endpoint too — the slot tracks "bytes in flight",
 * not "row written", so releasing on confirm is correct.
 */
export async function reserveUploadSlot(args: {
  workspaceId: string
  userId: number
  size: number
}): Promise<{ releaseSlots: () => Promise<void> }> {
  const caps = await resolveCaps({ workspaceId: args.workspaceId, uploaderId: args.userId })

  if (args.size > caps.maxFileBytes) {
    throw createError({
      statusCode: 413,
      message: `File too large. Max ${Math.round(caps.maxFileBytes / (1024 * 1024))} MB.`,
      data: { code: 'knowledge/file-too-large' }
    })
  }

  const [wsCount, wsBytes, userCount, userBytes] = await Promise.all([
    countWorkspaceKnowledge(args.workspaceId),
    sumWorkspaceKnowledgeBytes(args.workspaceId),
    countKnowledgeByUploader(args.userId),
    sumKnowledgeBytesByUploader(args.userId)
  ])

  if (wsCount >= caps.maxFilesPerWorkspace) {
    throw createError({
      statusCode: 409,
      message: `Workspace knowledge limit reached (${caps.maxFilesPerWorkspace} files).`,
      data: {
        code: 'knowledge/workspace-file-cap',
        recovery: limitRecovery()
      }
    })
  }
  if (wsBytes + args.size > caps.maxTotalBytesPerWorkspace) {
    throw createError({
      statusCode: 409,
      message: `Workspace knowledge storage limit reached (${Math.round(caps.maxTotalBytesPerWorkspace / (1024 * 1024))} MB).`,
      data: {
        code: 'knowledge/workspace-bytes-cap',
        recovery: limitRecovery()
      }
    })
  }
  if (userCount >= caps.maxFilesPerUser) {
    throw createError({
      statusCode: 409,
      message: `You've reached the per-user knowledge upload limit (${caps.maxFilesPerUser} files).`,
      data: {
        code: 'knowledge/user-file-cap',
        recovery: limitRecovery()
      }
    })
  }
  if (userBytes + args.size > caps.maxTotalBytesPerUser) {
    throw createError({
      statusCode: 409,
      message: `You've reached the per-user knowledge storage limit (${Math.round(caps.maxTotalBytesPerUser / (1024 * 1024))} MB).`,
      data: {
        code: 'knowledge/user-bytes-cap',
        recovery: limitRecovery()
      }
    })
  }

  // Reserve BOTH slots. If the second reservation fails, release the
  // first so the partial reservation doesn't pin a slot for the TTL.
  const wsSlotMax = Math.max(1, caps.maxFilesPerWorkspace - wsCount)
  const userSlotMax = Math.max(1, caps.maxFilesPerUser - userCount)

  const wsSlot = await reserveInflightSlot(INFLIGHT_NS_WORKSPACE, args.workspaceId, wsSlotMax, INFLIGHT_SLOT_TTL_MS)
  if (!wsSlot.allowed) {
    throw createError({
      statusCode: 409,
      message: 'Too many pending uploads for this workspace — try again in a moment.'
    })
  }
  const userSlot = await reserveInflightSlot(INFLIGHT_NS_USER, String(args.userId), userSlotMax, INFLIGHT_SLOT_TTL_MS)
  if (!userSlot.allowed) {
    await releaseInflightSlot(INFLIGHT_NS_WORKSPACE, args.workspaceId)
    throw createError({
      statusCode: 409,
      message: 'Too many pending uploads on your account — try again in a moment.'
    })
  }

  let released = false
  return {
    releaseSlots: async () => {
      if (released) return
      released = true
      await Promise.all([
        releaseInflightSlot(INFLIGHT_NS_WORKSPACE, args.workspaceId),
        releaseInflightSlot(INFLIGHT_NS_USER, String(args.userId))
      ])
    }
  }
}

/**
 * Re-check all caps at confirm time. Called INSIDE a DB transaction
 * with an advisory lock on the workspace row, so concurrent confirms
 * for the same workspace serialize and each one sees a fresh count.
 *
 * Doesn't touch the inflight counters — the confirm endpoint's caller
 * releases them after this function returns (success or failure).
 */
export async function assertCapsOnConfirm(args: {
  workspaceId: string
  userId: number
  size: number
}): Promise<void> {
  const caps = await resolveCaps({ workspaceId: args.workspaceId, uploaderId: args.userId })
  if (args.size > caps.maxFileBytes) {
    throw createError({ statusCode: 413, message: 'Uploaded file exceeds size limit' })
  }
  const [wsCount, wsBytes, userCount, userBytes] = await Promise.all([
    countWorkspaceKnowledge(args.workspaceId),
    sumWorkspaceKnowledgeBytes(args.workspaceId),
    countKnowledgeByUploader(args.userId),
    sumKnowledgeBytesByUploader(args.userId)
  ])
  if (wsCount >= caps.maxFilesPerWorkspace) {
    throw createError({ statusCode: 409, message: 'Workspace knowledge limit reached' })
  }
  if (wsBytes + args.size > caps.maxTotalBytesPerWorkspace) {
    throw createError({ statusCode: 409, message: 'Workspace knowledge storage limit reached' })
  }
  if (userCount >= caps.maxFilesPerUser) {
    throw createError({ statusCode: 409, message: 'Per-user knowledge limit reached' })
  }
  if (userBytes + args.size > caps.maxTotalBytesPerUser) {
    throw createError({ statusCode: 409, message: 'Per-user knowledge storage limit reached' })
  }
}
