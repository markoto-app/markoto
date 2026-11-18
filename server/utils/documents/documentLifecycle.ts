import { ListObjectsV2Command, DeleteObjectsCommand, type S3Client } from '@aws-sdk/client-s3'
import type { NotifyDeletedRequest } from '~~/shared/contracts/syncInternal'
import { allSyncStateKeys } from '~~/shared/contracts/syncState'
import { useValkey } from '../platform/valkey'
import { cleanupRendersForDoc } from '../rendering/renderClient'
import { prunePublishedObjects } from '../publish/publishDocument'
import { getPublishedPageSummary } from '../../repos/publishedPages'
import * as Sentry from '@sentry/nuxt'
import { captureExceptionThrottled } from '../platform/throttledSentry'
import { deleteActivityForDoc } from '../../repos/activity'
import { deleteUploadsForDoc } from '../../repos/uploads'
import { deleteDocRow } from '../../repos/documents'
import { injectTraceHeaders } from '../platform/traceHeaders'
import { useEnv } from '~~/shared/env/load'
import { useLogger } from '../platform/logger'
import type { DocAccess } from '../../repos/proofs'

const log = useLogger('document-lifecycle')

// Full-cascade deletion for a document. Used by:
// - `server/api/docs/[docId]/index.delete.ts` (user-initiated delete)
// - `server/plugins/inactive-doc-sweep.ts` (automated cleanup)
// - `server/api/workspaces/[wsId]/index.delete.ts` (workspace cascade)
//
// Callers prove the right to delete (`DocAccess<'delete'>`: the delete
// policy, a workspace admin's cascade, or the named sweeper) and this
// helper reaps everything associated with exactly that document.
//
// Ordering is load-bearing:
//   1. DB rows first, the doc "disappears" from the user's perspective
//      the instant this completes even if the later steps fail.
//   2. S3 cleanup: best effort; orphan-cleanup sweeps missed keys later.
//   3. Sync-server notify: fire-and-forget; broadcasts `ymeta._deleted`
//      to connected clients and clears the Y.js row log.
//
// The three steps are exported individually so tests can drive each
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
 * Step 1: delete the DB rows in FK-safe order (activity and uploads
 * reference documents). If this throws, the caller treats the whole
 * delete as failed: nothing external has been touched yet.
 */
export async function deleteDocDbRows(doc: DocAccess<'delete'>): Promise<void> {
  await deleteActivityForDoc(doc)
  await deleteUploadsForDoc(doc)
  await deleteDocRow(doc)
}

/**
 * Step 2: delete every S3 object under `docs/{docId}/`. Resolves
 * normally on success AND on failure, a wedged S3 must not prevent
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
    log.error('S3 cleanup failed', { docId, err: e })
    Sentry.captureException(e, {
      tags: { component: 'documentLifecycle', event: 's3_cleanup_failed', docId }
    })
    // Swallow: orphan-cleanup will catch this up.
    return 0
  }
}

/**
 * Step 3: fire-and-forget notify to the sync-server so it broadcasts
 * `ymeta._deleted` and clears Y.js rows. Returns synchronously (no
 * await on the POST), a wedged sync-server must not block the delete
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
    headers: injectTraceHeaders({
      'Content-Type': 'application/json',
      'X-Internal-Secret': deps.internalApiSecret
    }),
    body: JSON.stringify({ docId } satisfies NotifyDeletedRequest),
    signal: AbortSignal.timeout(3000)
  }).catch((e) => {
    log.warn('sync-server notify failed', { docId, err: e })
    captureExceptionThrottled('documentLifecycle.notify-deleted', e, {
      tags: { component: 'documentLifecycle', event: 'sync_notify_deleted_failed' }
    })
  })
  return true
}

/**
 * Delete the sync server's per-document Valkey state (attribution and
 * diff baselines, `shared/contracts/syncState.ts`). The sync server drops
 * it when it unloads a document, but a document that is not open there
 * (or open on another instance) would keep it for the 24 h TTL. Best
 * effort: a Valkey error is logged, never fails the delete.
 */
async function dropSyncDocState(docId: string): Promise<void> {
  try {
    await useValkey().del(...allSyncStateKeys(docId))
  } catch (e) {
    log.warn('sync state cleanup failed', { docId, err: e })
  }
}

/**
 * Orchestrator: runs the three steps in order. Production callers use
 * this; tests drive the steps directly for finer-grained assertions.
 */
export async function deleteDocument(doc: DocAccess<'delete'>): Promise<void> {
  // A published web page goes with the document (FK cascade); its
  // copied files are read first and deleted after (the orphan sweep is the
  // backstop).
  const published = await getPublishedPageSummary(doc)
  await deleteDocDbRows(doc)
  await cleanupDeletedDocument(doc.docId, published?.id ?? null)
}

/**
 * Many documents at once (a folder with everything in it, a bulk delete).
 * Each document's rows go first, one by one, so the request answers once
 * they are gone from every list; the storage, render and sync clean-up then
 * runs in the background, a few documents at a time (the orphan sweep reaps
 * whatever it misses). Returns the ids whose rows were deleted.
 */
export async function deleteDocuments(docs: ReadonlyArray<DocAccess<'delete'>>): Promise<string[]> {
  const deleted: Array<{ docId: string, publishedId: string | null }> = []
  for (const doc of docs) {
    try {
      const published = await getPublishedPageSummary(doc)
      await deleteDocDbRows(doc)
      deleted.push({ docId: doc.docId, publishedId: published?.id ?? null })
    } catch (e) {
      log.error('document delete failed', { docId: doc.docId, err: e })
    }
  }
  void (async () => {
    const queue = [...deleted]
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        await cleanupDeletedDocument(next.docId, next.publishedId).catch((e: unknown) => {
          log.warn('background clean-up failed', { docId: next.docId, err: e })
        })
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()])
  })()
  return deleted.map(d => d.docId)
}

/** Steps 2 and 3 for a document whose rows are gone. */
async function cleanupDeletedDocument(docId: string, publishedId: string | null): Promise<void> {
  const env = useEnv()
  await cleanupDocS3(docId, { s3: useS3Client(), bucket: env.storage.bucket })
  // Wipe any cached PDF / PNG renders for this doc. Same swallow-on-error
  // semantics as cleanupDocS3: orphaned render objects cost nothing
  // material and the bucket lifecycle policy will reap them eventually.
  await cleanupRendersForDoc(docId)
  if (publishedId !== null) await prunePublishedObjects(publishedId)
  await dropSyncDocState(docId)
  notifySyncDeleted(docId, {
    syncInternalUrl: env.sync.internalUrl,
    internalApiSecret: env.auth.internalApiSecret
  })
}
