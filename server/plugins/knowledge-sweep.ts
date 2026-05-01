import * as Sentry from '@sentry/nuxt'
import { and, eq, lt } from 'drizzle-orm'
import { workspaceKnowledge } from '../db/schema'
import { useDatabase } from '../utils/database'
import { migrationsComplete } from '../utils/migrations'
import { processKnowledge } from '../utils/processKnowledge'
import { deleteKnowledgeArtifact } from '../utils/knowledgeAccess'
import { acquireSweepLock, releaseSweepLock } from '../utils/sweepLock'

// Re-kicks knowledge-base uploads that got stuck in `status='processing'`
// past the deadline. Normal ingestion runs fire-and-forget from the
// confirm endpoint; this plugin only matters when the Nitro worker
// crashed between "row inserted" and "status flipped to ready/failed".
//
// Conservative deadline (10 min): markitdown can genuinely take minutes
// on large PDFs, and the embedding batches add a few seconds on top.
// Anything older than this is almost certainly a crash, not in-flight
// work.
//
// Idempotency: processKnowledge() deletes existing chunks by knowledgeId
// before re-inserting, so a mid-flight kill that left half the chunks
// behind still produces a clean result on retry.

const STALE_THRESHOLD_MS = 10 * 60 * 1000
const SWEEP_INTERVAL_MS = 2 * 60 * 1000

export default defineNitroPlugin((nitroApp) => {
  async function sweepStuck() {
    const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS)
    let stuck: Array<{ knowledgeId: string }>
    try {
      const db = useDatabase()
      stuck = await db.select({ knowledgeId: workspaceKnowledge.knowledgeId })
        .from(workspaceKnowledge)
        .where(and(
          eq(workspaceKnowledge.status, 'processing'),
          lt(workspaceKnowledge.createdAt, cutoff)
        ))
    } catch (e) {
      console.warn('[knowledge-sweep] stuck-query failed:', e instanceof Error ? e.message : e)
      Sentry.captureException(e, { tags: { component: 'knowledge-sweep', event: 'query_failed' } })
      return
    }
    for (const row of stuck) {
      console.warn(`[knowledge-sweep] Re-processing stuck knowledge ${row.knowledgeId}`)
      // Serialize — don't spawn unbounded parallel processing if a
      // previous sweep just flagged 100 rows as stuck after a crash.
      // processKnowledge already catches its own errors.
      await processKnowledge(row.knowledgeId)
    }
  }

  // Second sweep pass: reap failed rows past the TTL. Failed rows
  // hold S3 bytes (we never delete originals on failure — keeps the
  // retry path cheap) and count against the per-user quota, so
  // letting them linger forever would let "deliberate failure"
  // hoard quota. The TTL is per-ops comfort — operators looking at
  // errors get N days to see what's going wrong before cleanup.
  async function sweepFailed() {
    const cfg = useRuntimeConfig().knowledge
    const cutoffDays = cfg.failedRetentionDays
    if (cutoffDays <= 0) return
    const cutoff = new Date(Date.now() - cutoffDays * 24 * 60 * 60 * 1000)
    let rows: Array<{ knowledgeId: string }>
    try {
      const db = useDatabase()
      rows = await db.select({ knowledgeId: workspaceKnowledge.knowledgeId })
        .from(workspaceKnowledge)
        .where(and(
          eq(workspaceKnowledge.status, 'failed'),
          lt(workspaceKnowledge.createdAt, cutoff)
        ))
    } catch (e) {
      console.warn('[knowledge-sweep] failed-query failed:', e instanceof Error ? e.message : e)
      Sentry.captureException(e, { tags: { component: 'knowledge-sweep', event: 'failed_query_failed' } })
      return
    }
    for (const row of rows) {
      console.log(`[knowledge-sweep] Reaping expired failed row ${row.knowledgeId}`)
      // deleteKnowledgeArtifact is already idempotent: it no-ops if
      // the row is missing and best-effort deletes the S3 object.
      try {
        await deleteKnowledgeArtifact(row.knowledgeId)
      } catch (e) {
        console.warn(`[knowledge-sweep] reap failed for ${row.knowledgeId}:`, e instanceof Error ? e.message : e)
        // Surface to Sentry — repeated reap failures keep failed rows
        // hoarding per-user quota; on-call wants the signal.
        Sentry.captureException(e, {
          tags: { component: 'knowledge-sweep', event: 'reap_failed', knowledgeId: row.knowledgeId }
        })
      }
    }
  }

  async function sweep() {
    // Cross-instance gate: a single app instance runs both sub-sweeps
    // per tick. processKnowledge is idempotent if it does double-fire,
    // so this is purely a wastefulness guard, not a correctness one.
    if (!await acquireSweepLock('knowledge-sweep')) return
    try {
      await sweepStuck()
      await sweepFailed()
    } finally {
      await releaseSweepLock('knowledge-sweep')
    }
  }

  // Kick first sweep after migrations complete so we don't race 00-db-migrate
  // on a fresh DB.
  void (async () => {
    await migrationsComplete
    await sweep()
  })()

  const timer = setInterval(() => {
    void sweep()
  }, SWEEP_INTERVAL_MS)
  nitroApp.hooks.hook('close', () => clearInterval(timer))
})
