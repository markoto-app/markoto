import { snapshotAiSessions } from '../utils/aiSessions'

// Every 60s, iterate the in-memory AI session registry and abort any session
// older than the stale threshold. Protects against crashes that leave awareness
// entries orphaned on Hocuspocus docs.
//
// Normal sessions should clean up on their own via `finally`. This sweeper is
// strictly a safety net for crashes or unreachable error paths. The threshold
// must be strictly greater than the per-prompt HARD_DEADLINE_MS in
// `api/ai/prompt.post.ts` (currently 5 min) so legitimate long-running loops
// don't get killed prematurely.

const STALE_THRESHOLD_MS = 7 * 60 * 1000  // 7 min — safely longer than 5-min prompt deadline
const SWEEP_INTERVAL_MS = 60_000

export default defineNitroPlugin((nitroApp) => {
  function sweep() {
    const now = Date.now()
    for (const s of snapshotAiSessions()) {
      if (now - s.startedAt > STALE_THRESHOLD_MS) {
        console.warn(
          `[ai-sweep] Aborting stuck session ${s.sessionId} for doc ${s.docId} (age ${Math.round((now - s.startedAt) / 1000)}s)`
        )
        try {
          s.abortController.abort()
        } catch {
          // ignore; session will be re-examined on next sweep if still present
        }
      }
    }
  }

  const timer = setInterval(sweep, SWEEP_INTERVAL_MS)
  nitroApp.hooks.hook('close', () => clearInterval(timer))
})
