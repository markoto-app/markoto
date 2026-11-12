import { CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { confirmOwnUploadWithinQuota, deletePending, findOwnUpload } from '../../repos/uploads'
import { getDocWithActorRole } from '../../repos/documents'
import { requireContentMatchesExtension } from '../../utils/storage/fileTypeGuard'
import { parseUploadKey, stagingKeyFor } from '../../utils/storage/uploadKey'
import { canWriteDocContent } from '../../utils/documents/documentAccess'
import { imageQuotaError, resolveImageQuota } from '../../utils/storage/imageQuota'
import { confirmUploadBody } from '~~/shared/api/ai'
import { MINUTE_MS } from '~~/shared/config/units'
import { useEnv } from '~~/shared/env/load'

// The key is client-supplied, so it must have the exact shape
// `/api/upload/request` mints AND resolve to an `uploads` row issued to the
// caller. Anything else is a 404 BEFORE any S3 call (no existence oracle, and
// DeleteObject can only reach a key we issued to this user; the bucket also
// holds backups).
//
// The browser PUT lands on the staging key (`docs/{docId}/staging/{file}`).
// Confirm copies it to the final key and sniffs the COPY: the presigned URL
// stays valid for its lifetime and can rewrite the staging object at any
// time, but never the final object `/api/files` serves.
function notFound() {
  return apiError('upload/not-found')
}

/** The object's stored Content-Type must be exactly the type the upload was requested for. */
function requireStoredContentType(stored: string | undefined, expected: string): void {
  const normalised = stored?.split(';')[0]?.trim().toLowerCase()
  if (normalised !== expected.toLowerCase()) {
    throw apiError('upload/content-type-mismatch')
  }
}

/** The stored size must be the size the upload was requested (and reserved) for. */
function requireStoredSize(stored: number | undefined, expected: number): void {
  if (stored !== expected) {
    throw apiError('upload/size-mismatch')
  }
}

// One confirm per key at a time: a failing confirm deletes the final object,
// which must never race a concurrent confirm that succeeded.
const CONFIRM_LOCK_NS = 'upload-confirm'
const CONFIRM_LOCK_TTL_MS = 60_000

export default defineApiHandler({
  // The document is only known through the issued key, so the write gate is
  // inline, after the ownership checks that must stay 404 (see above).
  access: allow.user(),
  body: confirmUploadBody,
  rateLimit: { namespace: 'upload-confirm', max: 60, windowMs: MINUTE_MS, key: 'user', error: 'upload/rate-limited' },
  handler: async ({ user, body }) => {
    const userId = user.id

    const key = body.key
    const parsed = parseUploadKey(key)
    if (!parsed) throw notFound()

    const row = await findOwnUpload(key, userId)
    if (!row || row.docId !== parsed.docId) throw notFound()

    // Already confirmed (double confirm / retry): idempotent success, no S3 call.
    if (row.confirmedAt) {
      return { success: true, size: row.sizeBytes, contentType: row.contentType }
    }

    // Same write gate as /upload/request, re-checked in case access changed.
    const doc = await getDocWithActorRole(parsed.docId, userId)
    if (!doc) throw notFound()
    if (!canWriteDocContent(doc, userId)) throw apiError('auth/forbidden')

    if (!(await tryAcquireSessionLock(CONFIRM_LOCK_NS, key, CONFIRM_LOCK_TTL_MS))) {
      throw apiError('upload/confirm-in-progress')
    }
    try {
      return await confirmUpload({ key, userId, row, ext: parsed.ext, docId: parsed.docId })
    } finally {
      await releaseSessionLock(CONFIRM_LOCK_NS, key)
    }
  }
})

async function confirmUpload(args: {
  key: string
  userId: number
  row: { contentType: string, sizeBytes: number }
  ext: string
  docId: string
}) {
  const { key, userId, row } = args
  const s3 = useS3Client()
  const bucket = useEnv().storage.bucket
  const stagingKey = stagingKeyFor(key)

  const discard = async () => {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: stagingKey }))
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
      await deletePending(key, userId)
    } catch { /* orphan-cleanup sweeper covers it */ }
  }

  let head
  try {
    head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: stagingKey }))
  } catch {
    // Not landed (yet): keep the pending row so the client can retry.
    throw apiError('upload/not-landed')
  }

  // Stored type + size + magic-byte sniff: the presigned PUT binds the
  // Content-Type and length S3 records, not the actual bytes. On mismatch 415
  // AND delete the caller's own pending objects + row so garbage can't pile up.
  try {
    requireStoredContentType(head.ContentType, row.contentType)
    requireStoredSize(head.ContentLength, row.sizeBytes)
    // Copy first, then sniff the copy: bytes PUT to the staging key after
    // this point never reach the final key.
    await s3.send(new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `/${bucket}/${stagingKey}`,
      Key: key,
      ContentType: row.contentType,
      MetadataDirective: 'REPLACE'
    }))
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: stagingKey }))
    await requireContentMatchesExtension({ s3Key: key, ext: args.ext })
  } catch (e) {
    await discard()
    throw e
  }

  // Quota re-check + atomic flip. Bytes were reserved at request time; this
  // refuses only if the user is over quota NOW (e.g. a lower quota was
  // configured). 'missing' = the row vanished (doc deleted), so the object has
  // no owner and is dropped.
  const quota = await resolveImageQuota(userId, args.docId)
  const quotaBytes = quota.maxBytes
  const outcome = await confirmOwnUploadWithinQuota(key, userId, quotaBytes, quota.scope)
  if (outcome === 'over-quota') {
    await discard()
    throw imageQuotaError(quotaBytes)
  }
  if (outcome === 'missing') {
    await discard()
    throw notFound()
  }

  return {
    success: true,
    size: row.sizeBytes,
    contentType: row.contentType
  }
}
