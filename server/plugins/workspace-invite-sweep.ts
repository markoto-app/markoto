import { migrationsComplete } from '../utils/platform/migrations'
import { runWorkspaceInviteSweep } from '../utils/workspaces/workspaceInviteSweep'
import { acquireSweepLock, releaseSweepLock } from '../utils/platform/sweepLock'
import { SWEEPS } from '../config/sweeps'

// Hourly sweeper that deletes expired workspace invitations. Logic lives
// in `server/utils/workspaces/workspaceInviteSweep.ts` so tests can drive it
// directly.

const { intervalMs: SWEEP_INTERVAL_MS } = SWEEPS.workspaceInvites

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
