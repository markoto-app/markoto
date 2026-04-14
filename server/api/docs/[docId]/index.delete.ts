import { eq } from 'drizzle-orm'
import { ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import { documents, documentShares, workspaceDocuments, activityLog, uploads } from '../../../db/schema'

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const docId = requireDocId(event)
  const db = useDatabase()

  const doc = (await db.select({ ownerId: documents.ownerId }).from(documents).where(eq(documents.docId, docId)).limit(1))[0]
  if (!doc) {
    throw createError({ statusCode: 404, message: 'Document not found' })
  }
  if (doc.ownerId !== session.user.id) {
    throw createError({ statusCode: 403, message: 'Not the document owner' })
  }

  // Delete DB rows first (most critical — if this succeeds, the doc is gone
  // from the user's perspective even if S3 cleanup fails).
  await db.delete(activityLog).where(eq(activityLog.docId, docId))
  await db.delete(workspaceDocuments).where(eq(workspaceDocuments.docId, docId))
  await db.delete(documentShares).where(eq(documentShares.docId, docId))
  await db.delete(uploads).where(eq(uploads.docId, docId))
  await db.delete(documents).where(eq(documents.docId, docId))

  // Best-effort S3 cleanup — uploaded files only (Y.js state lives in Postgres
  // now, cleared by the sync-server via the notify-deleted internal call below).
  // If this fails we log and continue; the orphan-cleanup plugin reaps later.
  try {
    const s3 = useS3Client()
    const config = useRuntimeConfig()
    const prefix = `docs/${docId}/`

    // List all objects under the doc's prefix (paginated; SeaweedFS returns up to 1000 per page).
    let continuationToken: string | undefined
    const keysToDelete: { Key: string }[] = []

    do {
      const list = await s3.send(new ListObjectsV2Command({
        Bucket: config.s3.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken
      }))
      for (const obj of list.Contents || []) {
        if (obj.Key) keysToDelete.push({ Key: obj.Key })
      }
      continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined
    } while (continuationToken)

    // Batch delete (S3 DeleteObjects accepts up to 1000 keys per request).
    for (let i = 0; i < keysToDelete.length; i += 1000) {
      const batch = keysToDelete.slice(i, i + 1000)
      await s3.send(new DeleteObjectsCommand({
        Bucket: config.s3.bucket,
        Delete: { Objects: batch, Quiet: true }
      }))
    }
  } catch (e: any) {
    console.error(`[delete] S3 cleanup failed for ${docId}:`, e.message)
    // Don't fail the request — DB is already cleaned up
  }

  // Notify sync-server: it broadcasts deletion to connected clients AND clears
  // the Y.js rows from y-postgresql. Fire-and-forget — if sync is down, the
  // delete still succeeds from the client's perspective and the rows can be
  // pruned manually if they ever matter.
  const config = useRuntimeConfig()
  if (config.syncInternalUrl && config.internalApiSecret) {
    fetch(`${config.syncInternalUrl}/internal/notify-deleted`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': config.internalApiSecret
      },
      body: JSON.stringify({ docId }),
      signal: AbortSignal.timeout(3000)
    }).catch((e) => {
      console.warn(`[delete] sync-server notify failed for ${docId}:`, e.message)
    })
  }

  return { success: true }
})
