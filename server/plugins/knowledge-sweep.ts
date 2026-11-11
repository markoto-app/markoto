import * as Sentry from '@sentry/nuxt'
import { and, eq, lt } from 'drizzle-orm'
import { workspaceKnowledge } from '../db/schema'
import { useDatabase } from '../utils/platform/database'
import { processKnowledge } from '../utils/knowledge/processKnowledge'
import { deleteKnowledgeArtifact } from '../utils/knowledge/knowledgeAccess'
import { defineSweeper } from '../utils/platform/defineSweeper'
import { SWEEPS } from '../config/sweeps'
import { DAY_MS } from '~~/shared/config/units'

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

const { staleAfterMs: STALE_THRESHOLD_MS } = SWEEPS.knowledge

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

/**
 * Second sweep pass: reap failed rows past the TTL. Failed rows hold
 * S3 bytes (we never delete originals on failure — keeps the retry
 * path cheap) and count against the per-user quota, so letting them
 * linger forever would let "deliberate failure" hoard quota. The TTL
 * is per-ops comfort — operators looking at errors get N days to see
 * what's going wrong before cleanup.
 */
async function sweepFailed() {
  const cfg = useRuntimeConfig().knowledge
  const cutoffDays = cfg.failedRetentionDays
  if (cutoffDays <= 0) return
  const cutoff = new Date(Date.now() - cutoffDays * DAY_MS)
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

export default defineSweeper({
  name: 'knowledge-sweep',
  schedule: SWEEPS.knowledge,
  // A single instance runs both sub-sweeps per tick. processKnowledge is
  // idempotent if it does double-fire, so the lock is a wastefulness guard.
  run: async () => {
    await sweepStuck()
    await sweepFailed()
  }
})
