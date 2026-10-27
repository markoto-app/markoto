import { HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { confirmOwnUpload, deletePending, findOwnUpload } from '../../repos/uploads'
import { getDocWithActorRole } from '../../repos/documents'
import { requireContentMatchesExtension } from '../../utils/fileTypeGuard'
import { parseUploadKey } from '../../utils/uploadKey'
import { canWriteDocContent } from '../../utils/documentAccess'

// The key is client-supplied, so it is never trusted by itself: it must have
// the exact shape `/api/upload/request` mints AND resolve to an `uploads` row
// issued to the calling user. Anything else is a 404 BEFORE any S3 call (no
// existence oracle, and DeleteObject can only ever reach a key we issued to
// this user — the bucket also holds backups).
function notFound() {
  return createError({ statusCode: 404, message: 'Upload not found' })
}

/** The object's stored Content-Type must be exactly the type the upload was requested for. */
function requireStoredContentType(stored: string | undefined, expected: string): void {
  const normalised = stored?.split(';')[0]?.trim().toLowerCase()
  if (normalised !== expected.toLowerCase()) {
    throw createError({
      statusCode: 415,
      message: `Uploaded object has content type ${stored ?? 'none'}; expected ${expected}.`,
      data: { code: 'upload/content-type-mismatch' }
    })
  }
}

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id

  if (!(await checkRateLimit('upload-confirm', String(userId), 60, 60_000))) {
    throw createError({
      statusCode: 429,
      message: 'Too many uploads. Try again in a minute.',
      data: { code: 'upload/rate-limited' }
    })
  }

  const body = await readBody(event)
  const rawKey: unknown = body?.key
  if (!rawKey) {
    throw createError({ statusCode: 400, message: 'Missing key' })
  }
  const parsed = parseUploadKey(rawKey)
  if (!parsed || typeof rawKey !== 'string') throw notFound()
  const key = rawKey

  const row = await findOwnUpload(key, userId)
  if (!row || row.docId !== parsed.docId) throw notFound()

  // Already confirmed (double confirm / retry): idempotent success, no S3 call.
  if (row.confirmedAt) {
    return { success: true, size: row.sizeBytes, contentType: row.contentType }
  }

  // Same write gate as /upload/request, re-checked in case access changed
  // between request and confirm.
  const doc = await getDocWithActorRole(parsed.docId, userId)
  if (!doc) throw notFound()
  if (!canWriteDocContent(doc, userId)) {
    throw createError({ statusCode: 403, message: 'No write access to this document' })
  }

  const s3 = useS3Client()
  const config = useRuntimeConfig()

  let head
  try {
    head = await s3.send(new HeadObjectCommand({
      Bucket: config.s3.bucket,
      Key: key
    }))
  } catch {
    throw createError({ statusCode: 404, message: 'Upload not found in S3' })
  }

  // Stored type + magic-byte sniff. The presigned PUT binds the
  // Content-Type header S3 records (signed in /upload/request), not the
  // actual bytes. Both must match the requested image type; on mismatch
  // we 415 AND delete the caller's own pending object + row so garbage
  // can't pile up in the bucket.
  try {
    requireStoredContentType(head.ContentType, row.contentType)
    await requireContentMatchesExtension({ s3Key: key, ext: parsed.ext })
  } catch (e) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key }))
      await deletePending(key, userId)
    } catch { /* orphan-cleanup sweeper covers it */ }
    throw e
  }

  // Atomic flip; false means a concurrent confirm won, which is fine.
  await confirmOwnUpload(key, userId)

  return {
    success: true,
    size: head.ContentLength,
    contentType: head.ContentType
  }
})
