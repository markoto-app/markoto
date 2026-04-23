import * as Sentry from '@sentry/nuxt'
import { and, eq, lt } from 'drizzle-orm'
import { workspaceKnowledge } from '../db/schema'
import { useDatabase } from '../utils/database'
import { migrationsComplete } from '../utils/migrations'
import { processKnowledge } from '../utils/processKnowledge'

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
  async function sweep() {
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
      console.warn('[knowledge-sweep] query failed:', e instanceof Error ? e.message : e)
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
