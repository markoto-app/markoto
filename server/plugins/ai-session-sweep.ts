import * as Sentry from '@sentry/nuxt'
import { purgeStaleAiSessions, snapshotAiSessions, dropOrphanedAiSession } from '../utils/ai/aiSessions'
import { migrationsComplete } from '../utils/platform/migrations'
import { defineSweeper } from '../utils/platform/defineSweeper'
import { SWEEPS } from '../config/sweeps'
import { useLogger } from '../utils/platform/logger'

const log = useLogger('ai-session-sweep')

// Every 60s, abort any AI session older than the stale threshold. Protects
// against crashes that leave awareness entries orphaned on Hocuspocus docs.
//
// Normal sessions should clean up on their own via `finally`. This sweeper is
// strictly a safety net for crashes or unreachable error paths. The threshold
// must be strictly greater than the per-prompt HARD_DEADLINE_MS in
// `api/ai/prompt.post.ts` (currently 5 min) so legitimate long-running loops
// don't get killed prematurely.
//
// Sessions are DB-backed, so the plugin also purges once at startup: rows
// left by a crashed previous process are cleaned immediately instead of
// blocking the per-user cap until the first sweep.

const { staleAfterMs: STALE_THRESHOLD_MS } = SWEEPS.aiSessions

type AiSessionRow = Awaited<ReturnType<typeof snapshotAiSessions>>[number]

const sweeper = defineSweeper({
  name: 'ai-session-sweep',
  schedule: SWEEPS.aiSessions,
  // The startup purge below is the boot pass; the locked sweep starts one
  // interval later.
  runAtBoot: false,
  run: sweep
})

export default defineNitroPlugin((nitroApp) => {
  // Startup purge — clears any rows from a crashed prior process. Wait on
  // the migration signal first; otherwise on a freshly-provisioned DB the
  // query races `00-db-migrate.ts` and hits a missing table.
  if (!import.meta.prerender) void runStartupPurge()
  sweeper(nitroApp)
})

async function runStartupPurge(): Promise<void> {
  await migrationsComplete
  try {
    const removed = await purgeStaleAiSessions(STALE_THRESHOLD_MS)
    if (removed > 0) {
      log.info('purged stale AI session rows from a prior process', { removed })
    }
  } catch (e) {
    log.warn('Startup purge failed', { err: e })
    Sentry.captureException(e, { tags: { component: 'ai-sweep', event: 'startup_purge_failed' } })
  }
}

/**
 * Runs under the cross-instance lock. Note: `snapshotAiSessions` returns rows from
 * every instance's sessions, but `abortController` is per-process —
 * the winner instance can only abort its own loops; for orphan rows
 * (sessions running elsewhere), the loop falls through to
 * `dropOrphanedAiSession` which just drops the DB entry to unblock the
 * per-user cap.
 */
async function sweep(): Promise<void> {
  const sessions = await loadSessionsOrLog()
  if (!sessions) return
  const now = Date.now()
  for (const s of sessions) {
    const ageMs = now - s.startedAt.getTime()
    if (ageMs <= STALE_THRESHOLD_MS) continue
    await abortStaleSession(s, ageMs)
  }
}

/** Snapshot DB sessions; returns null on failure (already logged + Sentry-captured). */
async function loadSessionsOrLog(): Promise<AiSessionRow[] | null> {
  try {
    return await snapshotAiSessions()
  } catch (e) {
    log.warn('snapshot failed', { err: e })
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
  log.warn('aborting stuck AI session', { sessionId: s.sessionId, docId: s.docId, ageSeconds: Math.round(ageMs / 1000) })
  if (s.abortController) {
    try {
      s.abortController.abort()
    } catch { /* ignore */ }
    return
  }
  try {
    await dropOrphanedAiSession(s.sessionId)
  } catch { /* ignore */ }
}
