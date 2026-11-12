import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { nanoid } from 'nanoid'
import { DESIGN_IMPORT_MAX_BYTES, DESIGN_IMPORT_MAX_ROUNDS } from '~~/shared/config/designImport'
import { appendAuditEvent, truncateIp } from '../../../repos/audit'
import { AUDIT_DESIGN_IMPORT_STARTED } from '../../../legal/auditActions'
import { resolveBillingContext } from '../../../utils/billing/billing'
import { assertFreeAllowanceAvailable } from '../../../utils/billing/freeAllowance'
import { bytesMatchExtension } from '../../../utils/storage/fileTypeGuard'
import { claimPendingDesignUpload, requireVisionChatProvider } from '../../../utils/designImport/guard'
import { writeJob } from '../../../utils/designImport/job'
import { DESIGN_IMPORT_LOCK, runDesignImportJob } from '../../../utils/designImport/run'
import { designImportStartBody } from '~~/shared/api/brand'
import { MINUTE_MS } from '~~/shared/config/units'
import { useEnv } from '~~/shared/env/load'

/**
 * "Create a design from a document", step 2: read the uploaded file and
 * start the design run in the background. Body: `{ uploadId }`.
 *
 *   1. claim the caller's pending upload (404 otherwise — no S3 call)
 *   2. one run per user at a time (409 `design-import/busy`)
 *   3. vision provider + free-allowance check (same as any AI call)
 *   4. HEAD: stored type + size must be what was signed
 *   5. read the bytes, DELETE the object, sniff the bytes that were read
 *   6. audit, write the job, run (`utils/designImport/run.ts`)
 *
 * The original never stays in storage: it is deleted right after this read and
 * its bytes live in memory only until the markitdown call. Returns `{ jobId }`;
 * the dialog polls `GET .../jobs/:jobId`.
 */

/** Longest a run may hold the per-user lock (the run deadline is 6 min). */
const LOCK_TTL_MS = 7 * MINUTE_MS

export default defineApiHandler({
  access: allow.user(),
  body: designImportStartBody,
  handler: async ({ event, user, body: { uploadId } }) => {
    const userId = user.id
    const pending = await claimPendingDesignUpload(userId, uploadId)
    if (!pending) throw apiError('design-import/upload-not-found')

    const env = useEnv()
    const s3 = useS3Client()
    const bucket = env.storage.bucket
    const deleteObject = () => s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: pending.stagingKey })).catch(() => undefined)

    if (!(await tryAcquireSessionLock(DESIGN_IMPORT_LOCK, String(userId), LOCK_TTL_MS))) {
      await deleteObject()
      throw apiError('design-import/busy')
    }

    let started = false
    try {
      const provider = await requireVisionChatProvider(userId)
      const billing = await resolveBillingContext(userId, null)
      await assertFreeAllowanceAvailable(provider, billing.plan)

      let head
      try {
        head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: pending.stagingKey }))
      } catch {
        throw apiError('design-import/upload-missing')
      }
      if (head.ContentType !== pending.mimeType || head.ContentLength !== pending.size || pending.size > DESIGN_IMPORT_MAX_BYTES) {
        throw apiError('design-import/mismatch')
      }
      const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: pending.stagingKey }))
      const bytes = await got.Body?.transformToByteArray()
      if (!bytes || bytes.byteLength !== pending.size) {
        throw apiError('design-import/mismatch')
      }
      await deleteObject()
      if (!(await bytesMatchExtension(bytes, pending.ext))) {
        throw apiError('design-import/content-mismatch')
      }

      await appendAuditEvent({
        actorUserId: userId,
        actorIp: truncateIp(getClientIp(event)),
        scope: 'user',
        scopeId: String(userId),
        action: AUDIT_DESIGN_IMPORT_STARTED,
        metadata: { format: pending.ext, sizeBytes: pending.size }
      })

      const jobId = nanoid(16)
      await writeJob(jobId, { userId, phase: 'reading', round: 0, maxRounds: DESIGN_IMPORT_MAX_ROUNDS, format: pending.ext })
      // Background: the run releases the lock when it ends.
      void runDesignImportJob({ jobId, userId, bytes, ext: pending.ext, provider, virtualKey: billing.virtualKey })
      started = true
      return { jobId }
    } finally {
      if (!started) {
        await deleteObject()
        await releaseSessionLock(DESIGN_IMPORT_LOCK, String(userId)).catch(() => undefined)
      }
    }
  }
})
