import { PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { nanoid } from 'nanoid'
import { reserveUploadSlot } from '../../../../utils/knowledgeQuota'
import { recordPendingKnowledgeUpload } from '../../../../utils/knowledgePendingUpload'
import { stagingKeyFor } from '../../../../utils/uploadKey'

/**
 * Step 1 of knowledge upload: mint a presigned PUT URL.
 *
 * Guard order (fail early):
 *   1. auth (session cookie)
 *   2. workspace membership + editor/admin role
 *   3. IP + user rate limit on presigns (cheap DoS protection)
 *   4. extension allowlist (rejects .exe etc. before any DB work)
 *   5. per-user + per-workspace DB caps + Valkey inflight slot reserve
 *   6. presigned URL mint
 *
 * Row inserts happen at CONFIRM time, not here — that way an abandoned
 * upload (never PUT) doesn't create a `status='processing'` row the
 * sweep has to retry. Objects PUT but never confirmed (and staging
 * leftovers) are deleted by orphan-cleanup's knowledge pass
 * (`server/utils/knowledgeOrphanSweep.ts`) once they are older than its
 * grace period and no `workspace_knowledge` row references them.
 *
 * The URL writes a STAGING key (`…/knowledge/staging/{id}.{ext}`) with
 * `Content-Type` and length signed; confirm copies it to the final key
 * (`s3Key` below) and sniffs the copy, so re-using the URL later can't
 * swap the bytes processing reads.
 */

// Presigned PUT lifetime. S3 checks expiry when the request starts, so a
// slow 25 MB upload that begins in time still completes.
const KNOWLEDGE_PUT_TTL_SECONDS = 120

const EXT_TO_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  html: 'text/html',
  htm: 'text/html',
  epub: 'application/epub+zip',
  md: 'text/markdown',
  txt: 'text/plain'
}

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const wsId = requireWsId(event)
  const userId = session.user.id

  await requireKnowledgeEditAccess(event, wsId, userId)

  // Per-user rate limit on presign requests. 30 per minute is plenty
  // for a genuine power user batch-uploading; well below the volume
  // a script would need to meaningfully abuse signing throughput.
  if (!(await checkRateLimit('knowledge-upload', String(userId), 30, 60_000))) {
    throw createError({
      statusCode: 429,
      message: 'Too many upload requests. Try again in a minute.',
      data: { code: 'knowledge/rate-limited', messageKey: 'error.rateLimited' }
    })
  }

  const body = await readBody<{ filename?: unknown, size?: unknown }>(event)
  const filename = typeof body?.filename === 'string' ? body.filename.trim() : ''
  const size = typeof body?.size === 'number' ? body.size : Number.NaN

  if (!filename) {
    throw createError({ statusCode: 400, message: 'filename is required' })
  }
  if (filename.length > 255) {
    throw createError({ statusCode: 400, message: 'Filename too long (max 255)' })
  }
  if (!Number.isFinite(size) || size <= 0) {
    throw createError({ statusCode: 400, message: 'size must be a positive number' })
  }

  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const mimeType = EXT_TO_MIME[ext]
  if (!mimeType) {
    throw createError({
      statusCode: 415,
      message: `Unsupported format: .${ext}. Allowed: ${Object.keys(EXT_TO_MIME).join(', ')}`
    })
  }

  // Cap + inflight-slot reservation. Throws on any cap breach; returns
  // a releaser we invoke on the failure path after this point. The
  // confirm endpoint releases on success and on its own failures.
  const { releaseSlots } = await reserveUploadSlot({
    workspaceId: wsId,
    userId,
    size
  })

  const config = useRuntimeConfig()
  const knowledgeId = nanoid(12)
  const s3Key = `workspaces/${wsId}/knowledge/${knowledgeId}.${ext}`

  let uploadUrl: string
  try {
    const s3 = usePresignS3Client()
    // SSE NOTE: presigned PUTs deliberately omit `ServerSideEncryption`
    // — see server/api/upload/request.post.ts for the full rationale.
    // Bucket-level default-encryption (docs/S3-SETUP.md §6) covers the
    // browser PUT path; server-side direct PUTs set the header
    // explicitly as defense-in-depth.
    //
    // CONTENT-TYPE IS SIGNED (as for images): without it in the signed
    // headers the client could store the original under any type.
    // Confirm re-checks the stored type.
    uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: config.s3.bucket,
        Key: stagingKeyFor(s3Key),
        ContentType: mimeType,
        ContentLength: size
      }),
      { expiresIn: KNOWLEDGE_PUT_TTL_SECONDS, signableHeaders: new Set(['content-type']) }
    )
    // Confirm only accepts uploads recorded here, for this caller.
    await recordPendingKnowledgeUpload({ workspaceId: wsId, userId, knowledgeId }, { s3Key, ext, mimeType })
  } catch (e) {
    await releaseSlots()
    throw e
  }

  return {
    knowledgeId,
    uploadUrl,
    s3Key,
    ext,
    mimeType,
    expiresIn: KNOWLEDGE_PUT_TTL_SECONDS
  }
})
