import { eq } from 'drizzle-orm'
import { ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import * as Sentry from '@sentry/nuxt'
import { documents, documentShares, workspaceDocuments, activityLog, uploads } from '../db/schema'

// Full-cascade deletion for a document. Used by:
// - `server/api/docs/[docId]/index.delete.ts` (user-initiated delete)
// - `server/plugins/inactive-doc-sweep.ts` (automated cleanup)
//
// Callers are responsible for authorisation checks — this helper trusts
// its input docId and reaps everything associated.
//
// Order of operations matters: DB rows first (the doc "disappears" from
// the user's perspective the instant this completes), then S3 (best
// effort; orphan-cleanup sweeps missed keys later), then sync-server
// notify (broadcasts `ymeta._deleted` to connected clients and clears
// the Y.js row log). The notify is fire-and-forget with a 3s timeout
// so a wedged sync doesn't block the delete path.

export async function deleteDocument(docId: string): Promise<void> {
  const db = useDatabase()

  // Delete DB rows first. If this succeeds, the doc is gone from the
  // user's perspective even if S3 cleanup fails.
  await db.delete(activityLog).where(eq(activityLog.docId, docId))
  await db.delete(workspaceDocuments).where(eq(workspaceDocuments.docId, docId))
  await db.delete(documentShares).where(eq(documentShares.docId, docId))
  await db.delete(uploads).where(eq(uploads.docId, docId))
  await db.delete(documents).where(eq(documents.docId, docId))

  // S3 cleanup — uploaded files only. Y.js state lives in Postgres now,
  // cleared by the sync-server via the internal notify below.
  try {
    const s3 = useS3Client()
    const config = useRuntimeConfig()
    const prefix = `docs/${docId}/`

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

    // Batch delete (S3 DeleteObjects caps at 1000 keys per request).
    for (let i = 0; i < keysToDelete.length; i += 1000) {
      const batch = keysToDelete.slice(i, i + 1000)
      await s3.send(new DeleteObjectsCommand({
        Bucket: config.s3.bucket,
        Delete: { Objects: batch, Quiet: true }
      }))
    }
  } catch (e: any) {
    console.error(`[deleteDocument] S3 cleanup failed for ${docId}:`, e.message)
    Sentry.captureException(e, {
      tags: { component: 'documentLifecycle', event: 's3_cleanup_failed', docId }
    })
    // Don't throw — DB is already cleaned up; orphan-cleanup reaps later.
  }

  // Notify sync-server. Fire-and-forget — if sync is down, the delete
  // still succeeds from the client's perspective and the Y.js rows can
  // be pruned manually if they ever matter.
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
      console.warn(`[deleteDocument] sync-server notify failed for ${docId}:`, e.message)
    })
  }
}
