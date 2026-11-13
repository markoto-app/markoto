import {
  countWorkspaceKnowledge,
  sumWorkspaceKnowledgeBytes,
  countKnowledgeByUploader,
  sumKnowledgeBytesByUploader
} from '../../repos/knowledge'
import { reserveInflightSlot, releaseInflightSlot } from '../platform/rateLimit'
import { KNOWLEDGE_PLATFORM_LIMITS, type PlanName } from '~~/shared/config/tiers'
import { getTiers } from '~~/server/utils/billing/tierConfig'
import { limitRecovery } from '~~/server/utils/billing/billingMode'
import { resolveUserPlan, resolveWorkspacePlan } from '../billing/entitlements'
import { isBillingEnabled } from '../billing/billingMode'
import { getPooledWorkspace, workspacePoolCaps } from '../billing/workspaceBilling'
import { apiError } from '../api/apiError'
import { MIB } from '~~/shared/config/units'
import type { UserScope, WorkspaceAccess } from '../../repos/proofs'

/**
 * Per-user caps don't apply inside a pooled (Team / Business) workspace;
 * this stands in for "no per-user limit" there. Also bounds the per-user
 * inflight slots (Valkey wants a finite max).
 */
const POOLED_PER_USER_SENTINEL = Number.MAX_SAFE_INTEGER
const POOLED_USER_SLOT_MAX = 1000

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

// Inflight slot TTL. Matches the presigned-URL TTL (120s, upload-request)
// plus a safety margin so that an abandoned upload-request (user never
// PUTs) frees its slot soon after the URL is useless anyway, the margin
// covers clock skew + a slow upload + the confirm roundtrip.
const INFLIGHT_SLOT_TTL_MS = 180 * 1000

// Namespaces for the inflight counters. Keep them stable, they key
// into Valkey under `inflight:{namespace}:{key}`, so renaming would
// orphan live counters in production.
const INFLIGHT_NS_WORKSPACE = 'knowledge-upload-ws'
const INFLIGHT_NS_USER = 'knowledge-upload-user'
// One member's share of a workspace's slots (key `{wsId}:{userId}`).
const INFLIGHT_NS_WORKSPACE_MEMBER = 'knowledge-upload-ws-member'

/**
 * How many of a workspace's `wsSlots` free inflight slots one member may
 * hold at once: half (rounded up), so a single editor requesting presigns
 * without ever confirming can't lock every other member out. With one
 * slot left it's first come, first served, someone has to take it.
 */
export function memberShareOfWorkspaceSlots(wsSlots: number): number {
  return Math.max(1, Math.ceil(wsSlots / 2))
}

function workspaceMemberSlotKey(workspaceId: string, userId: number): string {
  return `${workspaceId}:${userId}`
}

/** Release every inflight counter one upload-request reserved. Best-effort. */
export async function releaseKnowledgeUploadSlots(workspaceId: string, userId: number): Promise<void> {
  await Promise.all([
    releaseInflightSlot(INFLIGHT_NS_WORKSPACE, workspaceId),
    releaseInflightSlot(INFLIGHT_NS_WORKSPACE_MEMBER, workspaceMemberSlotKey(workspaceId, userId)),
    releaseInflightSlot(INFLIGHT_NS_USER, String(userId))
  ])
}

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
  /**
   * Team / Business workspace: the workspace caps are the pool
   * (seats × per-seat), the uploader's personal caps don't apply, and
   * the files don't count against the uploader's personal storage.
   */
  pooled: boolean
}

// Plan resolution is shared with every other plan limit
// (server/utils/billing/entitlements.ts): the uploader's personal plan for the
// per-user caps, the workspace's plan (Team / Business subscription,
// else its creator's plan) for the per-workspace caps. A lapsed or
// deleted creator lands on `free`, an abandoned workspace doesn't keep
// paid storage room after its owner stopped paying.
const getEffectivePlan = resolveUserPlan
const getWorkspacePlan = resolveWorkspacePlan

/**
 * Resolve the full cap set for an upload. Per-workspace caps read the
 * workspace's effective plan (Team / Business subscription, else creator);
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
  const pool = await getPooledWorkspace(args.workspaceId)
  if (pool) {
    const poolCaps = workspacePoolCaps(pool.plan, pool.seats, tiers)
    return {
      maxFileBytes: KNOWLEDGE_PLATFORM_LIMITS.maxFileBytes,
      maxFilesPerWorkspace: poolCaps.knowledgeFiles,
      maxTotalBytesPerWorkspace: poolCaps.knowledgeBytes,
      maxFilesPerUser: POOLED_PER_USER_SENTINEL,
      maxTotalBytesPerUser: POOLED_PER_USER_SENTINEL,
      workspacePlan: pool.plan,
      uploaderPlan,
      pooled: true
    }
  }
  const wsTier = tiers[workspacePlan]
  const userTier = tiers[uploaderPlan]
  return {
    maxFileBytes: KNOWLEDGE_PLATFORM_LIMITS.maxFileBytes,
    maxFilesPerWorkspace: wsTier.knowledgeFiles,
    maxTotalBytesPerWorkspace: wsTier.knowledgeBytesPerWorkspace,
    maxFilesPerUser: userTier.knowledgeFiles,
    maxTotalBytesPerUser: userTier.knowledgeBytesPerUser,
    workspacePlan,
    uploaderPlan,
    pooled: false
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
 * in the confirm endpoint too, the slot tracks "bytes in flight",
 * not "row written", so releasing on confirm is correct.
 */
export async function reserveUploadSlot(args: KnowledgeUploadArgs): Promise<{ releaseSlots: () => Promise<void> }> {
  const workspaceId = args.ws.workspaceId
  const userId = args.self.userId
  const caps = await resolveCaps({ workspaceId, uploaderId: userId })

  const { wsCount, userCount } = await assertWithinCaps(caps, args)

  // Reserve BOTH slots. If the second reservation fails, release the
  // first so the partial reservation doesn't pin a slot for the TTL.
  const wsSlotMax = Math.max(1, caps.maxFilesPerWorkspace - wsCount)
  const userSlotMax = caps.pooled ? POOLED_USER_SLOT_MAX : Math.max(1, caps.maxFilesPerUser - userCount)

  // The member's own share of the workspace's slots is reserved FIRST, so
  // a member at their share never consumes a workspace slot.
  const memberKey = workspaceMemberSlotKey(workspaceId, userId)
  const memberSlot = await reserveInflightSlot(
    INFLIGHT_NS_WORKSPACE_MEMBER, memberKey, memberShareOfWorkspaceSlots(wsSlotMax), INFLIGHT_SLOT_TTL_MS
  )
  if (!memberSlot.allowed) {
    throw apiError('knowledge/too-many-pending')
  }
  const wsSlot = await reserveInflightSlot(INFLIGHT_NS_WORKSPACE, workspaceId, wsSlotMax, INFLIGHT_SLOT_TTL_MS)
  if (!wsSlot.allowed) {
    await releaseInflightSlot(INFLIGHT_NS_WORKSPACE_MEMBER, memberKey)
    throw apiError('knowledge/too-many-pending')
  }
  const userSlot = await reserveInflightSlot(INFLIGHT_NS_USER, String(userId), userSlotMax, INFLIGHT_SLOT_TTL_MS)
  if (!userSlot.allowed) {
    await Promise.all([
      releaseInflightSlot(INFLIGHT_NS_WORKSPACE, workspaceId),
      releaseInflightSlot(INFLIGHT_NS_WORKSPACE_MEMBER, memberKey)
    ])
    throw apiError('knowledge/too-many-pending')
  }

  let released = false
  return {
    releaseSlots: async () => {
      if (released) return
      released = true
      await releaseKnowledgeUploadSlots(workspaceId, userId)
    }
  }
}

/**
 * Re-check all caps at confirm time. Called INSIDE a DB transaction
 * with an advisory lock on the workspace row, so concurrent confirms
 * for the same workspace serialize and each one sees a fresh count.
 *
 * Doesn't touch the inflight counters, the confirm endpoint's caller
 * releases them after this function returns (success or failure).
 */
export async function assertCapsOnConfirm(args: KnowledgeUploadArgs): Promise<void> {
  const caps = await resolveCaps({ workspaceId: args.ws.workspaceId, uploaderId: args.self.userId })
  await assertWithinCaps(caps, args)
}

/** Whole megabytes, for the limit an error names. */
function megabytes(bytes: number): number {
  return Math.round(bytes / MIB)
}

/** One knowledge upload: the uploader's workspace proof, the uploader, the size. */
interface KnowledgeUploadArgs {
  ws: WorkspaceAccess<'member'>
  self: UserScope
  size: number
}

/**
 * Refuses a file of `size` bytes that would pass a cap: its size, the
 * workspace's file count and bytes, the uploader's file count and bytes.
 * The error names the limit, so a client (or an MCP agent) knows what to
 * delete or how much fits. Returns the current counts.
 */
async function assertWithinCaps(caps: KnowledgeCaps, args: KnowledgeUploadArgs): Promise<{ wsCount: number, userCount: number }> {
  if (args.size > caps.maxFileBytes) {
    throw apiError('knowledge/file-too-large', { maxMb: megabytes(caps.maxFileBytes) })
  }
  const [wsCount, wsBytes, userCount, userBytes] = await Promise.all([
    countWorkspaceKnowledge(args.ws),
    sumWorkspaceKnowledgeBytes(args.ws),
    countKnowledgeByUploader(args.self, { excludePooled: isBillingEnabled() }),
    sumKnowledgeBytesByUploader(args.self, { excludePooled: isBillingEnabled() })
  ])
  if (wsCount >= caps.maxFilesPerWorkspace) {
    throw apiError('knowledge/workspace-file-cap', { max: caps.maxFilesPerWorkspace, recovery: limitRecovery() })
  }
  if (wsBytes + args.size > caps.maxTotalBytesPerWorkspace) {
    throw apiError('knowledge/workspace-bytes-cap', { maxMb: megabytes(caps.maxTotalBytesPerWorkspace), recovery: limitRecovery() })
  }
  if (userCount >= caps.maxFilesPerUser) {
    throw apiError('knowledge/user-file-cap', { max: caps.maxFilesPerUser, recovery: limitRecovery() })
  }
  if (userBytes + args.size > caps.maxTotalBytesPerUser) {
    throw apiError('knowledge/user-bytes-cap', { maxMb: megabytes(caps.maxTotalBytesPerUser), recovery: limitRecovery() })
  }
  return { wsCount, userCount }
}
