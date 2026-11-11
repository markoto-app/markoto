import { eq } from 'drizzle-orm'
import { documents, users } from '../db/schema'
import { useDatabase } from './database'
import { getTiers } from './tierConfig'
import { effectivePlan, isBillingEnabled, limitRecovery, limitUpgradeHint } from './billingMode'
import { getPooledWorkspace, workspacePoolCaps } from './workspaceBilling'
import type { ImageQuotaScope } from '../repos/uploads'

// Per-user storage quota for document images (`imageBytesPerUser` in
// shared/config/tiers.ts, overridable via TIER_<PLAN>_IMAGE_BYTES_PER_USER).
// Usage = the sum of the user's `uploads` rows, pending AND confirmed; the
// atomic reservation lives in server/repos/uploads.ts. Enforced at:
//   - POST /api/upload/request   (reservePendingUpload)
//   - POST /api/upload/confirm   (confirmOwnUploadWithinQuota)
//   - AI generate_image          (reservePendingUpload before the S3 PUT)
//   - POST /api/docs/:id/duplicate (copies count against the duplicator)

const IMAGE_QUOTA_CODE = 'upload/storage-quota'
const IMAGE_QUOTA_MESSAGE_KEY = 'image.storageQuotaReached'

/** The user's image byte quota under their effective plan. */
async function resolveImageQuotaBytes(userId: number): Promise<number> {
  const db = useDatabase()
  const rows = await db
    .select({ plan: users.plan, planValidUntil: users.planValidUntil })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  const row = rows[0]
  const plan = row ? effectivePlan(row.plan, row.planValidUntil) : 'free'
  return getTiers()[plan].imageBytesPerUser
}

export interface ImageQuota {
  scope: ImageQuotaScope
  maxBytes: number
  /** True when the images count against a Team / Business workspace's pool. */
  pooled: boolean
}

/**
 * The quota an image in `docId`, uploaded / generated / copied by
 * `userId`, counts against: the document's Team / Business workspace pool
 * (seats × per-seat `imageBytesPerUser`) or the user's personal quota.
 */
export async function resolveImageQuota(userId: number, docId: string | null, targetWorkspaceId?: string | null): Promise<ImageQuota> {
  // `targetWorkspaceId` for a document that doesn't exist yet (duplicate).
  const workspaceId = targetWorkspaceId !== undefined
    ? targetWorkspaceId
    : docId
      ? (await useDatabase().select({ workspaceId: documents.workspaceId }).from(documents).where(eq(documents.docId, docId)).limit(1))[0]?.workspaceId ?? null
      : null
  const pool = await getPooledWorkspace(workspaceId)
  if (pool) {
    return {
      scope: { kind: 'workspace', workspaceId: pool.workspaceId },
      maxBytes: workspacePoolCaps(pool.plan, pool.seats).imageBytes,
      pooled: true
    }
  }
  return {
    scope: { kind: 'user', uploaderId: userId, excludePooled: isBillingEnabled() },
    maxBytes: await resolveImageQuotaBytes(userId),
    pooled: false
  }
}

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

/** English fallback sentence (tool results, clients without the i18n key). */
export function imageQuotaMessage(limitBytes: number): string {
  return `You've reached your image storage limit (${formatMegabytes(limitBytes)}). `
    + `Images you remove from your documents (or deleted documents) free up space once they are cleaned up. ${limitUpgradeHint()}`
}

/** 409 with a stable code + i18n key; never mentions a purchase that doesn't exist. */
export function imageQuotaError(limitBytes: number) {
  return createError({
    statusCode: 409,
    message: imageQuotaMessage(limitBytes),
    data: {
      code: IMAGE_QUOTA_CODE,
      messageKey: IMAGE_QUOTA_MESSAGE_KEY,
      recovery: limitRecovery()
    }
  })
}
