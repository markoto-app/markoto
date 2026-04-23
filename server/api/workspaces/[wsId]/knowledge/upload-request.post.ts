import { PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { nanoid } from 'nanoid'
import { countWorkspaceKnowledge, sumWorkspaceKnowledgeBytes } from '../../../../repos/knowledge'

/**
 * Step 1 of knowledge upload: mint a presigned PUT URL.
 *
 * We intentionally DO NOT insert the DB row here. That happens at confirm
 * time once the client has successfully PUT the bytes. Reason: if we
 * insert first, a user who abandons the upload leaves `status='processing'`
 * rows behind; the knowledge-sweep plugin would try to re-process
 * something that doesn't exist in S3. Orphaned S3 objects (user PUTs but
 * never confirms) are caught by the existing orphan-cleanup plugin via
 * prefix sweep.
 *
 * Caps checked here so we 409 before the user uploads. We re-check at
 * confirm time too — races between concurrent uploads can squeak past.
 */

// Markitdown's supported input formats. `md` / `txt` skip markitdown
// and go straight to the chunker (fast path), but for simplicity we
// route everything through markitdown for now.
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

  const config = useRuntimeConfig()
  if (size > config.knowledge.maxFileBytes) {
    throw createError({
      statusCode: 413,
      message: `File too large. Max ${Math.round(config.knowledge.maxFileBytes / (1024 * 1024))} MB.`
    })
  }

  // Workspace-level caps (soft — only checked at upload time).
  const [currentCount, currentBytes] = await Promise.all([
    countWorkspaceKnowledge(wsId),
    sumWorkspaceKnowledgeBytes(wsId)
  ])
  if (currentCount >= config.knowledge.maxFilesPerWorkspace) {
    throw createError({
      statusCode: 409,
      message: `Workspace knowledge limit reached (${config.knowledge.maxFilesPerWorkspace} files).`
    })
  }
  if (currentBytes + size > config.knowledge.maxTotalBytesPerWorkspace) {
    throw createError({
      statusCode: 409,
      message: `Workspace knowledge storage limit reached (${Math.round(config.knowledge.maxTotalBytesPerWorkspace / (1024 * 1024))} MB).`
    })
  }

  const knowledgeId = nanoid(12)
  const s3Key = `workspaces/${wsId}/knowledge/${knowledgeId}.${ext}`

  const s3 = useS3Client()
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: s3Key,
      ContentType: mimeType,
      ContentLength: size
    }),
    { expiresIn: 300 }
  )

  // Return the fields the client echoes back to /confirm. `knowledgeId`
  // is pre-generated so the S3 key is deterministic without a second
  // DB round-trip.
  return {
    knowledgeId,
    uploadUrl,
    s3Key,
    ext,
    mimeType,
    expiresIn: 300
  }
})
