import { migrationsComplete } from '../utils/migrations'
import { runWorkspaceInviteSweep } from '../utils/workspaceInviteSweep'
import { acquireSweepLock, releaseSweepLock } from '../utils/sweepLock'

// Hourly sweeper that deletes expired workspace invitations. Logic lives
// in `server/utils/workspaceInviteSweep.ts` so tests can drive it
// directly.

const SWEEP_INTERVAL_MS = 60 * 60 * 1000 // 1h

async function lockedRun(): Promise<void> {
  if (!await acquireSweepLock('workspace-invite-sweep')) return
  try {
    await runWorkspaceInviteSweep()
  } finally {
    await releaseSweepLock('workspace-invite-sweep')
  }
}

export default defineNitroPlugin((nitroApp) => {
  void (async () => {
    await migrationsComplete
    await lockedRun()
  })()

  const timer = setInterval(() => {
    void lockedRun()
  }, SWEEP_INTERVAL_MS)
  nitroApp.hooks.hook('close', () => clearInterval(timer))
})
