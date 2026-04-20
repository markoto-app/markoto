import { and, isNull, lt } from 'drizzle-orm'
import { ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import * as Sentry from '@sentry/nuxt'
import { documents, uploads } from '../db/schema'

const ONE_HOUR_MS = 60 * 60 * 1000
const ONE_DAY_MS = 24 * ONE_HOUR_MS

// Reconciles S3 against the documents + uploads tables. Three layers:
//
//   1. Unconfirmed-upload sweep: delete uploads rows where confirmed_at IS NULL
//      AND created_at < now - 24h. Their S3 object (if any) is also removed.
//      Catches abandoned upload flows (user requested a presigned URL but
//      never PUT, or PUT failed on the client side).
//
//   2. Doc-level orphan sweep: list `docs/{id}/` prefixes; if `id` isn't in
//      the documents table, drop the entire prefix. Catches force-deletes
//      where the per-row cascade missed something.
//
//   3. Defensive S3 sweep: under each surviving doc prefix, list objects and
//      drop any whose key isn't in uploads AND whose last-modified is
//      > 24h old. The 24h grace prevents racing the create-doc flow (where
//      a file can briefly land in S3 before its uploads row commits, though
//      our request handler now writes the row first — kept for belt-and-
//      suspenders).
//
// Runs once on server startup (after a 30s delay so other subsystems are
// ready), then every hour.
export default defineNitroPlugin((nitroApp) => {
  let running = false

  async function reconcile() {
    if (running) return
    running = true
    try {
      const s3 = useS3Client()
      const config = useRuntimeConfig()
      const db = useDatabase()
      const now = Date.now()

      // ─── 1. Unconfirmed-upload sweep ──────────────────────────────────
      const cutoff = new Date(now - ONE_DAY_MS)
      const stale = await db.select({ s3Key: uploads.s3Key })
        .from(uploads)
        .where(and(isNull(uploads.confirmedAt), lt(uploads.createdAt, cutoff)))

      if (stale.length > 0) {
        const keysToDelete = stale.map(u => ({ Key: u.s3Key }))
        for (let i = 0; i < keysToDelete.length; i += 1000) {
          const batch = keysToDelete.slice(i, i + 1000)
          try {
            await s3.send(new DeleteObjectsCommand({
              Bucket: config.s3.bucket,
              Delete: { Objects: batch, Quiet: true }
            }))
          } catch (e) {
            console.warn('[orphan-cleanup] S3 delete failed during unconfirmed sweep:', e instanceof Error ? e.message : e)
            Sentry.captureException(e, { tags: { component: 'orphan-cleanup', event: 's3_delete_failed', sweep: 'unconfirmed' } })
          }
        }
        // Drop the rows whether or not the S3 delete succeeded — the row
        // itself is what blocks future re-use, and the S3 sweep below catches
        // any leftover objects.
        await db.delete(uploads).where(and(isNull(uploads.confirmedAt), lt(uploads.createdAt, cutoff)))
        console.log(`[orphan-cleanup] Reaped ${stale.length} unconfirmed upload row(s)`)
      }

      // ─── 2. Doc-level orphan sweep ────────────────────────────────────
      const prefixes: string[] = []
      let continuationToken: string | undefined
      do {
        const list = await s3.send(new ListObjectsV2Command({
          Bucket: config.s3.bucket,
          Prefix: 'docs/',
          Delimiter: '/',
          ContinuationToken: continuationToken
        }))
        for (const p of list.CommonPrefixes || []) {
          if (p.Prefix) prefixes.push(p.Prefix) // e.g. "docs/abc123/"
        }
        continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined
      } while (continuationToken)

      const s3DocIds = prefixes
        .map(p => p.replace(/^docs\//, '').replace(/\/$/, ''))
        .filter(Boolean)

      const existingDocs = await db.select({ docId: documents.docId }).from(documents)
      const existingDocSet = new Set(existingDocs.map(d => d.docId))
      const orphanDocs = s3DocIds.filter(id => !existingDocSet.has(id))

      let totalDocLevelDeleted = 0
      for (const orphanId of orphanDocs) {
        const orphanPrefix = `docs/${orphanId}/`
        const keysToDelete: { Key: string }[] = []
        let token: string | undefined
        do {
          const list = await s3.send(new ListObjectsV2Command({
            Bucket: config.s3.bucket,
            Prefix: orphanPrefix,
            ContinuationToken: token
          }))
          for (const obj of list.Contents || []) {
            if (obj.Key) keysToDelete.push({ Key: obj.Key })
          }
          token = list.IsTruncated ? list.NextContinuationToken : undefined
        } while (token)

        for (let i = 0; i < keysToDelete.length; i += 1000) {
          const batch = keysToDelete.slice(i, i + 1000)
          await s3.send(new DeleteObjectsCommand({
            Bucket: config.s3.bucket,
            Delete: { Objects: batch, Quiet: true }
          }))
          totalDocLevelDeleted += batch.length
        }
      }
      if (orphanDocs.length > 0) {
        console.log(`[orphan-cleanup] Reaped ${totalDocLevelDeleted} object(s) from ${orphanDocs.length} orphan doc prefix(es)`)
      }

      // ─── 3. Defensive S3 sweep ────────────────────────────────────────
      // For surviving doc prefixes, drop any S3 objects without a matching
      // uploads row AND older than the 24h race window.
      const allUploads = await db.select({ s3Key: uploads.s3Key }).from(uploads)
      const knownKeys = new Set(allUploads.map(u => u.s3Key))
      const liveDocPrefixes = s3DocIds.filter(id => existingDocSet.has(id))
      const ageCutoff = now - ONE_DAY_MS
      const defensiveBatch: { Key: string }[] = []

      for (const id of liveDocPrefixes) {
        const prefix = `docs/${id}/`
        let token: string | undefined
        do {
          const list = await s3.send(new ListObjectsV2Command({
            Bucket: config.s3.bucket,
            Prefix: prefix,
            ContinuationToken: token
          }))
          for (const obj of list.Contents || []) {
            if (!obj.Key) continue
            if (knownKeys.has(obj.Key)) continue
            const lastMod = obj.LastModified ? obj.LastModified.getTime() : now
            if (lastMod < ageCutoff) defensiveBatch.push({ Key: obj.Key })
          }
          token = list.IsTruncated ? list.NextContinuationToken : undefined
        } while (token)
      }

      if (defensiveBatch.length > 0) {
        for (let i = 0; i < defensiveBatch.length; i += 1000) {
          const batch = defensiveBatch.slice(i, i + 1000)
          await s3.send(new DeleteObjectsCommand({
            Bucket: config.s3.bucket,
            Delete: { Objects: batch, Quiet: true }
          }))
        }
        console.log(`[orphan-cleanup] Defensive sweep removed ${defensiveBatch.length} untracked S3 object(s) older than 24h`)
      }
    } catch (e) {
      console.error('[orphan-cleanup] Reconciliation failed:', e instanceof Error ? e.message : e)
      Sentry.captureException(e, { tags: { component: 'orphan-cleanup', event: 'reconcile_failed' } })
    } finally {
      running = false
    }
  }

  // Run once on startup (after a short delay so other subsystems are ready).
  const startupTimer = setTimeout(() => {
    void reconcile()
  }, 30_000)
  // Then run every hour.
  const intervalTimer = setInterval(() => {
    void reconcile()
  }, ONE_HOUR_MS)

  nitroApp.hooks.hook('close', () => {
    clearTimeout(startupTimer)
    clearInterval(intervalTimer)
  })
})
