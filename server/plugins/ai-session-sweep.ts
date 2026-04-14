import * as Sentry from '@sentry/nuxt'
import { purgeStaleAiSessions, snapshotAiSessions, removeAiSession } from '../utils/aiSessions'
import { migrationsComplete } from '../utils/migrations'

// Every 60s, abort any AI session older than the stale threshold. Protects
// against crashes that leave awareness entries orphaned on Hocuspocus docs.
//
// Normal sessions should clean up on their own via `finally`. This sweeper is
// strictly a safety net for crashes or unreachable error paths. The threshold
// must be strictly greater than the per-prompt HARD_DEADLINE_MS in
// `api/ai/prompt.post.ts` (currently 5 min) so legitimate long-running loops
// don't get killed prematurely.
//
// Now that sessions are DB-backed, the plugin also runs a one-shot purge at
// startup — any rows left over from a crashed previous process are cleaned
// immediately instead of blocking the per-user cap until the first sweep.

const STALE_THRESHOLD_MS = 7 * 60 * 1000  // 7 min — safely longer than 5-min prompt deadline
const SWEEP_INTERVAL_MS = 60_000

export default defineNitroPlugin((nitroApp) => {
  // Startup purge — clears any rows from a crashed prior process. Wait on
  // the migration signal first; otherwise on a freshly-provisioned DB the
  // query races `00-db-migrate.ts` and hits a missing table.
  void (async () => {
    await migrationsComplete
    try {
      const removed = await purgeStaleAiSessions(STALE_THRESHOLD_MS)
      if (removed > 0) {
        console.log(`[ai-sweep] Startup: purged ${removed} stale AI session row(s) from a prior process.`)
      }
    } catch (e: any) {
      console.warn('[ai-sweep] Startup purge failed:', e?.message || e)
      Sentry.captureException(e, { tags: { component: 'ai-sweep', event: 'startup_purge_failed' } })
    }
  })()

  async function sweep() {
    const now = Date.now()
    let sessions: Awaited<ReturnType<typeof snapshotAiSessions>>
    try {
      sessions = await snapshotAiSessions()
    } catch (e: any) {
      console.warn('[ai-sweep] snapshot failed:', e?.message || e)
      Sentry.captureException(e, { tags: { component: 'ai-sweep', event: 'snapshot_failed' } })
      return
    }
    for (const s of sessions) {
      const ageMs = now - s.startedAt.getTime()
      if (ageMs <= STALE_THRESHOLD_MS) continue
      console.warn(
        `[ai-sweep] Aborting stuck session ${s.sessionId} for doc ${s.docId} (age ${Math.round(ageMs / 1000)}s)`
      )
      if (s.abortController) {
        // Local to this process — signal the loop to unwind cleanly. The loop's
        // finally block will remove the session row itself.
        try { s.abortController.abort() } catch { /* ignore */ }
      } else {
        // Orphan row (e.g. from a prior process). Just drop the DB entry so the
        // per-user cap unblocks.
        try { await removeAiSession(s.sessionId) } catch { /* ignore */ }
      }
    }
  }

  const timer = setInterval(() => { void sweep() }, SWEEP_INTERVAL_MS)
  nitroApp.hooks.hook('close', () => clearInterval(timer))
})
