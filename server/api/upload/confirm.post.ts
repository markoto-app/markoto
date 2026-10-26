import { HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { confirmOwnUpload, deletePending, findOwnUpload } from '../../repos/uploads'
import { getDoc } from '../../repos/documents'
import { requireContentMatchesExtension } from '../../utils/fileTypeGuard'
import { parseUploadKey } from '../../utils/uploadKey'
import { canEditDoc } from '../../utils/workspaceAccess'

// The key is client-supplied, so it is never trusted by itself: it must have
// the exact shape `/api/upload/request` mints AND resolve to an `uploads` row
// issued to the calling user. Anything else is a 404 BEFORE any S3 call (no
// existence oracle, and DeleteObject can only ever reach a key we issued to
// this user — the bucket also holds backups).
function notFound() {
  return createError({ statusCode: 404, message: 'Upload not found' })
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
  const doc = await getDoc(parsed.docId)
  if (!doc) throw notFound()
  if (doc.accessMode !== 'open-edit' && !(await canEditDoc(userId, parsed.docId))) {
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

  // Magic-byte sniff. The presigned PUT only binds the Content-Type header
  // S3 records — not the actual bytes. On mismatch we 415 AND delete the
  // caller's own pending object + row so garbage can't pile up in the bucket.
  try {
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
