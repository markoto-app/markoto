import { HeadObjectCommand } from '@aws-sdk/client-s3'
import { createKnowledge, disambiguateFilename, sumWorkspaceKnowledgeBytes, countWorkspaceKnowledge } from '../../../../repos/knowledge'
import { resolveEmbeddingsConfig, embeddingVersionTag } from '../../../../utils/embeddings'
import { processKnowledge } from '../../../../utils/processKnowledge'

/**
 * Step 2: after the client has PUT the file to S3, call this to:
 *   1. Verify the object actually exists (HEAD check — same pattern as
 *      the image upload confirm endpoint).
 *   2. Disambiguate filename against existing workspace entries.
 *   3. Insert the workspace_knowledge row with status='processing'.
 *   4. Kick off processing asynchronously — we return immediately so
 *      the UI can show the "processing" state; the sweep plugin rescues
 *      stuck rows if this Nitro worker dies mid-pipeline.
 */

const SAFE_KEY_RE = /^workspaces\/[A-Za-z0-9_-]+\/knowledge\/[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const wsId = requireWsId(event)
  const userId = session.user.id

  await requireKnowledgeEditAccess(event, wsId, userId)

  const body = await readBody<{
    knowledgeId?: unknown
    s3Key?: unknown
    filename?: unknown
    ext?: unknown
    mimeType?: unknown
  }>(event)

  const knowledgeId = typeof body?.knowledgeId === 'string' ? body.knowledgeId : ''
  const s3Key = typeof body?.s3Key === 'string' ? body.s3Key : ''
  const filename = typeof body?.filename === 'string' ? body.filename.trim() : ''
  const ext = typeof body?.ext === 'string' ? body.ext.toLowerCase() : ''
  const mimeType = typeof body?.mimeType === 'string' ? body.mimeType : ''

  if (!knowledgeId || !s3Key || !filename || !ext || !mimeType) {
    throw createError({ statusCode: 400, message: 'Missing required fields' })
  }
  // The s3Key shape must match what upload-request built — otherwise a
  // malicious client could point us at any workspace's key.
  if (!SAFE_KEY_RE.test(s3Key)) {
    throw createError({ statusCode: 400, message: 'Invalid s3Key' })
  }
  if (!s3Key.startsWith(`workspaces/${wsId}/knowledge/`)) {
    throw createError({ statusCode: 400, message: 'Key does not belong to this workspace' })
  }

  const config = useRuntimeConfig()
  const s3 = useS3Client()

  let head
  try {
    head = await s3.send(new HeadObjectCommand({
      Bucket: config.s3.bucket,
      Key: s3Key
    }))
  } catch {
    throw createError({ statusCode: 404, message: 'Upload not found in storage' })
  }
  const sizeBytes = head.ContentLength ?? 0
  if (sizeBytes <= 0) {
    throw createError({ statusCode: 400, message: 'Uploaded object has no size' })
  }
  if (sizeBytes > config.knowledge.maxFileBytes) {
    throw createError({ statusCode: 413, message: 'Uploaded file exceeds size limit' })
  }

  // Re-check workspace caps at confirm time — upload-request reserved a
  // spot, but concurrent uploads could squeak past.
  const [currentCount, currentBytes] = await Promise.all([
    countWorkspaceKnowledge(wsId),
    sumWorkspaceKnowledgeBytes(wsId)
  ])
  if (currentCount >= config.knowledge.maxFilesPerWorkspace) {
    throw createError({ statusCode: 409, message: 'Workspace knowledge limit reached' })
  }
  if (currentBytes + sizeBytes > config.knowledge.maxTotalBytesPerWorkspace) {
    throw createError({ statusCode: 409, message: 'Workspace knowledge storage limit reached' })
  }

  const safeName = await disambiguateFilename(wsId, filename)
  const embeddingVersion = embeddingVersionTag(resolveEmbeddingsConfig())

  await createKnowledge({
    knowledgeId,
    workspaceId: wsId,
    filename: safeName,
    sourceExt: ext,
    mimeType,
    sizeBytes,
    s3Key,
    embeddingVersion,
    uploaderId: userId
  })

  // Fire-and-forget. We deliberately don't await. Errors inside
  // processKnowledge flip the row to `failed` with an error message;
  // the sweep plugin catches anything orphaned by a crash.
  void processKnowledge(knowledgeId).catch((e) => {
    console.error(`[knowledge/confirm] background processKnowledge(${knowledgeId}) failed:`, e)
  })

  return {
    knowledgeId,
    filename: safeName,
    status: 'processing' as const
  }
})
