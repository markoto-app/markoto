import { ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import { documents } from '../db/schema'

const ONE_HOUR_MS = 60 * 60 * 1000

// Reconciles S3 against the documents table:
//   1. Lists unique top-level `docs/{id}/` prefixes in S3
//   2. For each, checks if `id` exists in the documents table
//   3. Deletes all files under orphan prefixes
//
// Runs once on server startup, then every hour. Runs only on the main worker
// (not duplicated across multiple Nitro workers).
export default defineNitroPlugin((nitroApp) => {
  let running = false

  async function reconcile() {
    if (running) return // Don't stack runs if previous is still going
    running = true
    try {
      const s3 = useS3Client()
      const config = useRuntimeConfig()
      const db = useDatabase()

      // Enumerate top-level prefixes under `docs/` using Delimiter='/'
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

      if (prefixes.length === 0) return

      // Extract docIds from prefixes
      const s3DocIds = prefixes
        .map(p => p.replace(/^docs\//, '').replace(/\/$/, ''))
        .filter(Boolean)

      // Find which of these docIds still exist in the database
      const existingDocs = db.select({ docId: documents.docId }).from(documents).all()
      const existingSet = new Set(existingDocs.map(d => d.docId))

      const orphans = s3DocIds.filter(id => !existingSet.has(id))
      if (orphans.length === 0) return

      console.log(`[orphan-cleanup] Found ${orphans.length} orphan prefix(es) in S3:`, orphans)

      // Delete each orphan prefix (list + batch delete)
      let totalDeleted = 0
      for (const orphanId of orphans) {
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
          totalDeleted += batch.length
        }
      }

      console.log(`[orphan-cleanup] Reaped ${totalDeleted} object(s) from ${orphans.length} orphan prefix(es)`)
    } catch (e: any) {
      console.error('[orphan-cleanup] Reconciliation failed:', e.message)
    } finally {
      running = false
    }
  }

  // Run once on startup (after a short delay so other subsystems are ready).
  const startupTimer = setTimeout(() => { reconcile() }, 30_000)

  // Then run every hour.
  const intervalTimer = setInterval(() => { reconcile() }, ONE_HOUR_MS)

  nitroApp.hooks.hook('close', () => {
    clearTimeout(startupTimer)
    clearInterval(intervalTimer)
  })
})
