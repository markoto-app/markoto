import * as Sentry from '@sentry/nuxt'
import { purgeStaleAiSessions, snapshotAiSessions, removeAiSession } from '../utils/aiSessions'
import { migrationsComplete } from '../utils/migrations'
import { acquireSweepLock, releaseSweepLock } from '../utils/sweepLock'

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

const STALE_THRESHOLD_MS = 7 * 60 * 1000 // 7 min — safely longer than 5-min prompt deadline
const SWEEP_INTERVAL_MS = 60_000

type AiSessionRow = Awaited<ReturnType<typeof snapshotAiSessions>>[number]

export default defineNitroPlugin((nitroApp) => {
  // Startup purge — clears any rows from a crashed prior process. Wait on
  // the migration signal first; otherwise on a freshly-provisioned DB the
  // query races `00-db-migrate.ts` and hits a missing table.
  void runStartupPurge()

  const timer = setInterval(() => {
    void sweep()
  }, SWEEP_INTERVAL_MS)
  nitroApp.hooks.hook('close', () => clearInterval(timer))
})

async function runStartupPurge(): Promise<void> {
  await migrationsComplete
  try {
    const removed = await purgeStaleAiSessions(STALE_THRESHOLD_MS)
    if (removed > 0) {
      console.log(`[ai-sweep] Startup: purged ${removed} stale AI session row(s) from a prior process.`)
    }
  } catch (e) {
    console.warn('[ai-sweep] Startup purge failed:', e instanceof Error ? e.message : e)
    Sentry.captureException(e, { tags: { component: 'ai-sweep', event: 'startup_purge_failed' } })
  }
}

/**
 * Cross-instance gate. Note: `snapshotAiSessions` returns rows from
 * every instance's sessions, but `abortController` is per-process —
 * the winner instance can only abort its own loops; for orphan rows
 * (sessions running elsewhere), the loop falls through to
 * `removeAiSession` which just drops the DB entry to unblock the
 * per-user cap. That matches the pre-lock behaviour for sessions
 * from a prior crashed process.
 */
async function sweep(): Promise<void> {
  if (!await acquireSweepLock('ai-session-sweep')) return
  try {
    const sessions = await loadSessionsOrLog()
    if (!sessions) return
    const now = Date.now()
    for (const s of sessions) {
      const ageMs = now - s.startedAt.getTime()
      if (ageMs <= STALE_THRESHOLD_MS) continue
      await abortStaleSession(s, ageMs)
    }
  } finally {
    await releaseSweepLock('ai-session-sweep')
  }
}

/** Snapshot DB sessions; returns null on failure (already logged + Sentry-captured). */
async function loadSessionsOrLog(): Promise<AiSessionRow[] | null> {
  try {
    return await snapshotAiSessions()
  } catch (e) {
    console.warn('[ai-sweep] snapshot failed:', e instanceof Error ? e.message : e)
    Sentry.captureException(e, { tags: { component: 'ai-sweep', event: 'snapshot_failed' } })
    return null
  }
}

/**
 * Abort a stale session. Local rows: abort the controller (the
 * loop's finally clears the DB row itself). Orphan rows from a
 * prior process: drop directly so the per-user cap unblocks.
 */
async function abortStaleSession(s: AiSessionRow, ageMs: number): Promise<void> {
  console.warn(
    `[ai-sweep] Aborting stuck session ${s.sessionId} for doc ${s.docId} (age ${Math.round(ageMs / 1000)}s)`
  )
  if (s.abortController) {
    try {
      s.abortController.abort()
    } catch { /* ignore */ }
    return
  }
  try {
    await removeAiSession(s.sessionId)
  } catch { /* ignore */ }
}
