import { eq } from 'drizzle-orm'
import { users } from '../db/schema'
import { useDatabase } from './database'
import { getTiers } from './tierConfig'
import { effectivePlan, limitRecovery, limitUpgradeHint } from './billingMode'

// Per-user storage quota for document images (`imageBytesPerUser` in
// shared/config/tiers.ts, overridable via TIER_<PLAN>_IMAGE_BYTES_PER_USER).
// Usage = the sum of the user's `uploads` rows, pending AND confirmed; the
// atomic reservation lives in server/repos/uploads.ts. Enforced at:
//   - POST /api/upload/request   (reservePendingUpload)
//   - POST /api/upload/confirm   (confirmOwnUploadWithinQuota)
//   - AI generate_image          (reservePendingUpload before the S3 PUT)
//   - POST /api/docs/:id/duplicate (copies count against the duplicator)

export const IMAGE_QUOTA_CODE = 'upload/storage-quota'
export const IMAGE_QUOTA_MESSAGE_KEY = 'image.storageQuotaReached'

/** The user's image byte quota under their effective plan. */
export async function resolveImageQuotaBytes(userId: number): Promise<number> {
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

export function formatMegabytes(bytes: number): string {
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
