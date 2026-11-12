import { sweepPublishedOrphans } from '../utils/publish/orphanSweep'
import { listPublishedPageIds } from '../repos/publishedPages'
import { ListObjectsV2Command, DeleteObjectsCommand, type S3Client } from '@aws-sdk/client-s3'
import * as Sentry from '@sentry/nuxt'
import { listAllDocIds } from '../repos/documents'
import { listStaleUnconfirmed, purgeStaleUnconfirmed, listAllS3Keys } from '../repos/uploads'
import { defineSweeper } from '../utils/platform/defineSweeper'
import { sweepKnowledgeOrphans } from '../utils/knowledge/knowledgeOrphanSweep'
import { sweepDesignImportOrphans } from '../utils/designImport/orphanSweep'
import { s3ObjectStore } from '../utils/storage/objectStore'
import { stagingKeyFor } from '../utils/storage/uploadKey'
import { SWEEPS } from '../config/sweeps'
import { DAY_MS } from '~~/shared/config/units'
import { useEnv } from '~~/shared/env/load'
import { useLogger } from '../utils/platform/logger'
import { system } from '../repos/proofs'

/** The orphan sweep reconciles every document's storage against the database. */
const ORPHAN_CLEANUP = system('orphan-cleanup')

const log = useLogger('orphan-cleanup')

// Reconciles S3 against the documents + uploads + workspace_knowledge
// tables. Four layers:
//
//   1. Unconfirmed-upload sweep: delete uploads rows where confirmed_at
//      IS NULL AND created_at < now - 24h. Their S3 objects (final AND
//      staging key, if any) are also removed. Catches abandoned upload
//      flows (user requested a presigned URL but never PUT, PUT failed on
//      the client side, or never confirmed).
//
//   2. Doc-level orphan sweep: list `docs/{id}/` prefixes; if `id` isn't
//      in the documents table, drop the entire prefix. Catches force-
//      deletes where the per-row cascade missed something.
//
//   3. Defensive S3 sweep: under each surviving doc prefix, list objects
//      and drop any whose key isn't in uploads AND whose last-modified
//      is > 24h old. The 24h grace prevents racing the create-doc flow
//      (where a file can briefly land in S3 before its uploads row
//      commits; the request handler writes the row first, so this is a
//      backstop). Also catches staging objects
//      (`docs/{id}/staging/…`) left over after a confirm.
//
//   4. Knowledge sweep (`server/utils/knowledge/knowledgeOrphanSweep.ts`): objects
//      under `workspaces/*/knowledge/` (final or staging) older than 1 h
//      that no `workspace_knowledge` row points at, uploads that were
//      PUT but never confirmed, and originals of deleted rows. Runs even
//      when the doc layers failed.
//
// Runs once on server startup (after a 30s delay so other subsystems are
// ready), then every hour. The per-process non-overlap and the advisory lock
// (across instances) come from `defineSweeper`.
export default defineSweeper({
  name: 'orphan-cleanup',
  schedule: SWEEPS.orphanCleanup,
  // Each layer reports its own failure and the next layer still runs, so
  // this body never throws.
  run: async () => {
    const s3 = useS3Client()
    const bucket = useEnv().storage.bucket
    const now = Date.now()

    try {
      await sweepUnconfirmedUploads(s3, bucket)
      const { liveDocIds } = await sweepDocLevelOrphans(s3, bucket)
      await sweepDefensiveStaleS3(s3, bucket, liveDocIds, now)
    } catch (e) {
      log.error('Reconciliation failed', { err: e })
      Sentry.captureException(e, { tags: { component: 'orphan-cleanup', event: 'reconcile_failed' } })
    }
    try {
      const { deleted } = await sweepKnowledgeOrphans({ store: s3ObjectStore(s3, bucket), now })
      if (deleted > 0) log.info('reaped orphaned knowledge objects', { deleted })
    } catch (e) {
      log.error('Knowledge sweep failed', { err: e })
      Sentry.captureException(e, { tags: { component: 'orphan-cleanup', event: 'knowledge_sweep_failed' } })
    }
    try {
      const { deleted } = await sweepDesignImportOrphans({ store: s3ObjectStore(s3, bucket), now })
      if (deleted > 0) log.info('reaped design-import objects', { deleted })
    } catch (e) {
      log.error('Design-import sweep failed', { err: e })
      Sentry.captureException(e, { tags: { component: 'orphan-cleanup', event: 'design_import_sweep_failed' } })
    }
    try {
      const { deleted } = await sweepPublishedOrphans({ store: s3ObjectStore(s3, bucket), livePageIds: () => listPublishedPageIds(ORPHAN_CLEANUP), now })
      if (deleted > 0) log.info('reaped objects of unpublished pages', { deleted })
    } catch (e) {
      log.error('Published-page sweep failed', { err: e })
      Sentry.captureException(e, { tags: { component: 'orphan-cleanup', event: 'published_sweep_failed' } })
    }
  }
})

/**
 * Layer 1: drop uploads rows that were never confirmed (presigned URL
 * issued but no confirm POST landed) AND their corresponding S3
 * objects, if any. Older than 24h.
 */
async function sweepUnconfirmedUploads(s3: S3Client, bucket: string): Promise<void> {
  const stale = await listStaleUnconfirmed(ORPHAN_CLEANUP, DAY_MS)
  if (stale.length === 0) return

  await deleteObjectsBatched(
    s3,
    bucket,
    stale.flatMap(u => [u.s3Key, stagingKeyFor(u.s3Key)]),
    'unconfirmed'
  )
  // Drop the rows whether or not the S3 delete succeeded, the row
  // itself is what blocks future re-use, and the defensive S3 sweep
  // below catches any leftover objects.
  await purgeStaleUnconfirmed(ORPHAN_CLEANUP, DAY_MS)
  log.info('reaped unconfirmed upload rows', { reaped: stale.length })
}

/**
 * Layer 2: enumerate `docs/{id}/` prefixes; drop any whose `id` isn't
 * in `documents`. Returns the set of doc-ids that DID match (for the
 * defensive sweep to focus on).
 */
async function sweepDocLevelOrphans(
  s3: S3Client,
  bucket: string
): Promise<{ liveDocIds: string[] }> {
  const prefixes = await listDocPrefixes(s3, bucket)
  const s3DocIds = prefixes
    .map(p => p.replace(/^docs\//, '').replace(/\/$/, ''))
    .filter(Boolean)
  const existingDocSet = new Set(await listAllDocIds(ORPHAN_CLEANUP))
  const orphanDocs = s3DocIds.filter(id => !existingDocSet.has(id))

  let totalDeleted = 0
  for (const orphanId of orphanDocs) {
    const keys = await listKeysUnderPrefix(s3, bucket, `docs/${orphanId}/`)
    await deleteObjectsBatched(s3, bucket, keys, 'doc-orphan', { silent: true })
    totalDeleted += keys.length
  }
  if (orphanDocs.length > 0) {
    log.info('reaped objects of orphan doc prefixes', { objects: totalDeleted, prefixes: orphanDocs.length })
  }
  return { liveDocIds: s3DocIds.filter(id => existingDocSet.has(id)) }
}

/**
 * Layer 3: under each LIVE doc prefix, drop S3 objects without a
 * matching uploads row AND older than the 24h race window.
 */
async function sweepDefensiveStaleS3(
  s3: S3Client,
  bucket: string,
  liveDocIds: string[],
  now: number
): Promise<void> {
  const knownKeys = new Set(await listAllS3Keys(ORPHAN_CLEANUP))
  const ageCutoff = now - DAY_MS
  const stale: string[] = []

  for (const id of liveDocIds) {
    stale.push(...await findStaleKeysInDocPrefix(s3, bucket, id, knownKeys, ageCutoff, now))
  }

  if (stale.length > 0) {
    await deleteObjectsBatched(s3, bucket, stale, 'defensive', { silent: true })
    log.info('defensive sweep removed untracked S3 objects', { removed: stale.length })
  }
}

/**
 * Walk one `docs/{id}/` prefix paginated and return keys that are
 * BOTH absent from `uploads` (the known-keys set) AND older than the
 * 24h race window. The age guard exists so an upload that's
 * mid-flight (PUT in S3 but row not committed yet) doesn't get
 * reaped: see `sweepUnconfirmedUploads` for the inverse pass.
 */
async function findStaleKeysInDocPrefix(
  s3: S3Client,
  bucket: string,
  docId: string,
  knownKeys: Set<string>,
  ageCutoff: number,
  fallbackNow: number
): Promise<string[]> {
  const stale: string[] = []
  const prefix = `docs/${docId}/`
  let token: string | undefined
  do {
    const list = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: token
    }))
    for (const obj of list.Contents ?? []) {
      if (!obj.Key || knownKeys.has(obj.Key)) continue
      const lastMod = obj.LastModified ? obj.LastModified.getTime() : fallbackNow
      if (lastMod < ageCutoff) stale.push(obj.Key)
    }
    token = list.IsTruncated ? list.NextContinuationToken : undefined
  } while (token)
  return stale
}

/** List immediate `docs/{id}/` prefixes via the delimited Prefix API. */
async function listDocPrefixes(s3: S3Client, bucket: string): Promise<string[]> {
  const out: string[] = []
  let token: string | undefined
  do {
    const list = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: 'docs/',
      Delimiter: '/',
      ContinuationToken: token
    }))
    for (const p of list.CommonPrefixes ?? []) {
      if (p.Prefix) out.push(p.Prefix) // e.g. "docs/abc123/"
    }
    token = list.IsTruncated ? list.NextContinuationToken : undefined
  } while (token)
  return out
}

/** Enumerate every key under a prefix, paginated. */
async function listKeysUnderPrefix(s3: S3Client, bucket: string, prefix: string): Promise<string[]> {
  const out: string[] = []
  let token: string | undefined
  do {
    const list = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: token
    }))
    for (const obj of list.Contents ?? []) {
      if (obj.Key) out.push(obj.Key)
    }
    token = list.IsTruncated ? list.NextContinuationToken : undefined
  } while (token)
  return out
}

/**
 * Delete a list of S3 keys in 1000-key batches (the DeleteObjects API
 * cap). Errors land in Sentry tagged with the sweep label so dashboards
 * can attribute failures to the right layer.
 *
 * `opts.silent`: by default, the unconfirmed sweep already logs every
 * S3 error inline; the doc-orphan + defensive sweeps
 * let exceptions propagate to the outer try/catch so a transient S3
 * failure aborts THAT layer cleanly without nuking the rest. Set
 * `silent: true` to suppress the inline log + Sentry capture.
 */
async function deleteObjectsBatched(
  s3: S3Client,
  bucket: string,
  keys: string[],
  sweepLabel: string,
  opts: { silent?: boolean } = {}
): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000).map(Key => ({ Key }))
    try {
      await s3.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: batch, Quiet: true }
      }))
    } catch (e) {
      if (opts.silent) throw e
      log.warn('S3 delete failed', { sweep: sweepLabel, err: e })
      Sentry.captureException(e, { tags: { component: 'orphan-cleanup', event: 's3_delete_failed', sweep: sweepLabel } })
    }
  }
}
