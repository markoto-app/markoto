import * as Sentry from '@sentry/nuxt'
import { migrationsComplete } from '../utils/migrations'
import { runAiRecordsSweep, AI_RECORD_RETENTION_DAYS } from '../utils/aiRecordsSweep'
import { acquireSweepLock, releaseSweepLock } from '../utils/sweepLock'

// Enforces the 90-day retention the privacy policy promises for AI prompt +
// tool-call records (`ai_session_messages`), plus reaps orphaned
// `ai_sessions` rows past the same window. See `utils/aiRecordsSweep.ts`.
//
// Mirrors `mcp-sessions-sweep`: advisory-locked (cross-instance dedup),
// 30s startup delay, daily cadence. Daily is plenty — a bulk DELETE WHERE
// created_at < cutoff, indexed on created_at (composite) / started_at.

const STARTUP_DELAY_MS = 30_000
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000

let running = false

async function sweep(): Promise<void> {
  if (running) return
  running = true
  // Cross-instance dedup. Session-pinned advisory lock; release in finally.
  if (!(await acquireSweepLock('ai-records-sweep'))) {
    running = false
    return
  }
  try {
    await migrationsComplete

    const { messagesDeleted, sessionsDeleted } = await runAiRecordsSweep()
    if (messagesDeleted > 0 || sessionsDeleted > 0) {
      console.log(
        `[ai-records-sweep] purged ${messagesDeleted} memory row(s) + ${sessionsDeleted} stale session(s) older than ${AI_RECORD_RETENTION_DAYS}d`
      )
    }
  } catch (e) {
    console.warn('[ai-records-sweep] sweep failed:', e instanceof Error ? e.message : e)
    Sentry.captureException(e, {
      tags: { component: 'ai-records-sweep', event: 'sweep_failed' }
    })
  } finally {
    await releaseSweepLock('ai-records-sweep')
    running = false
  }
}

export default defineNitroPlugin((nitroApp) => {
  const startupTimer = setTimeout(() => {
    void sweep()
  }, STARTUP_DELAY_MS)
  const intervalTimer = setInterval(() => {
    void sweep()
  }, SWEEP_INTERVAL_MS)

  nitroApp.hooks.hook('close', () => {
    clearTimeout(startupTimer)
    clearInterval(intervalTimer)
  })
})
