import { ListObjectsV2Command, DeleteObjectsCommand, type S3Client } from '@aws-sdk/client-s3'
import { cleanupRendersForDoc } from './renderClient'
import * as Sentry from '@sentry/nuxt'
import { captureExceptionThrottled } from './throttledSentry'
import { deleteActivityForDoc } from '../repos/activity'
import { deleteUploadsForDoc } from '../repos/uploads'
import { deleteDocRow } from '../repos/documents'

// Full-cascade deletion for a document. Used by:
// - `server/api/docs/[docId]/index.delete.ts` (user-initiated delete)
// - `server/plugins/inactive-doc-sweep.ts` (automated cleanup)
// - `server/api/workspaces/[wsId]/index.delete.ts` (workspace cascade)
//
// Callers are responsible for authorisation checks — this helper trusts
// its input docId and reaps everything associated.
//
// Ordering is load-bearing:
//   1. DB rows first — the doc "disappears" from the user's perspective
//      the instant this completes even if the later phases fail.
//   2. S3 cleanup — best effort; orphan-cleanup sweeps missed keys later.
//   3. Sync-server notify — fire-and-forget; broadcasts `ymeta._deleted`
//      to connected clients and clears the Y.js row log.
//
// The three phases are exported individually so tests can drive each
// failure-isolation case (S3 down, sync-server down, bad config) without
// having to mock the whole transitive graph.

export interface DocumentLifecycleDeps {
  s3: Pick<S3Client, 'send'>
  bucket: string
  syncInternalUrl: string | null | undefined
  internalApiSecret: string | null | undefined
  fetchFn?: typeof fetch
}

/**
 * Phase 1: delete the DB rows in FK-safe order (activity and uploads
 * reference documents). If this throws, the caller treats the whole
 * delete as failed — nothing external has been touched yet.
 */
export async function deleteDocDbRows(docId: string): Promise<void> {
  await deleteActivityForDoc(docId)
  await deleteUploadsForDoc(docId)
  await deleteDocRow(docId)
}

/**
 * Phase 2: delete every S3 object under `docs/{docId}/`. Resolves
 * normally on success AND on failure — a wedged S3 must not prevent
 * the caller from returning 200. On failure, reports to Sentry + logs;
 * the orphan-cleanup plugin reaps the remaining objects later.
 *
 * Returns the number of objects actually deleted so tests + ops can
 * tell "nothing to clean up" from "cleanup failed silently".
 */
export async function cleanupDocS3(
  docId: string,
  deps: Pick<DocumentLifecycleDeps, 's3' | 'bucket'>
): Promise<number> {
  const prefix = `docs/${docId}/`
  try {
    const keysToDelete: { Key: string }[] = []
    let continuationToken: string | undefined
    do {
      const list = await deps.s3.send(new ListObjectsV2Command({
        Bucket: deps.bucket,
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
      await deps.s3.send(new DeleteObjectsCommand({
        Bucket: deps.bucket,
        Delete: { Objects: batch, Quiet: true }
      }))
    }
    return keysToDelete.length
  } catch (e) {
    console.error(`[deleteDocument] S3 cleanup failed for ${docId}:`, e instanceof Error ? e.message : e)
    Sentry.captureException(e, {
      tags: { component: 'documentLifecycle', event: 's3_cleanup_failed', docId }
    })
    // Swallow — orphan-cleanup will catch this up.
    return 0
  }
}

/**
 * Phase 3: fire-and-forget notify to the sync-server so it broadcasts
 * `ymeta._deleted` and clears Y.js rows. Returns synchronously (no
 * await on the POST) — a wedged sync-server must not block the delete
 * path. Returns `true` if the notify was dispatched, `false` when
 * config is missing (dev without sync).
 *
 * `fetchFn` is injectable so tests can assert the request shape
 * without a live HTTP stub.
 */
export function notifySyncDeleted(
  docId: string,
  deps: Pick<DocumentLifecycleDeps, 'syncInternalUrl' | 'internalApiSecret' | 'fetchFn'>
): boolean {
  if (!deps.syncInternalUrl || !deps.internalApiSecret) return false
  const doFetch = deps.fetchFn ?? fetch
  doFetch(`${deps.syncInternalUrl}/internal/notify-deleted`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': deps.internalApiSecret
    },
    body: JSON.stringify({ docId }),
    signal: AbortSignal.timeout(3000)
  }).catch((e) => {
    console.warn(`[deleteDocument] sync-server notify failed for ${docId}:`, e instanceof Error ? e.message : e)
    captureExceptionThrottled('documentLifecycle.notify-deleted', e, {
      tags: { component: 'documentLifecycle', event: 'sync_notify_deleted_failed' }
    })
  })
  return true
}

/**
 * Orchestrator: runs the three phases in order. Production callers use
 * this; tests drive the phases directly for finer-grained assertions.
 */
export async function deleteDocument(docId: string): Promise<void> {
  await deleteDocDbRows(docId)

  const config = useRuntimeConfig()
  await cleanupDocS3(docId, { s3: useS3Client(), bucket: config.s3.bucket })
  // Wipe any cached PDF / PNG renders for this doc. Same swallow-on-error
  // semantics as cleanupDocS3 — orphaned render objects cost nothing
  // material and the bucket lifecycle policy will reap them eventually.
  await cleanupRendersForDoc(docId)
  notifySyncDeleted(docId, {
    syncInternalUrl: config.syncInternalUrl,
    internalApiSecret: config.internalApiSecret
  })
}
