import { migrationsComplete } from '../utils/migrations'
import { runWorkspaceBudgetAlerts } from '../utils/workspaceBudgetAlerts'
import { acquireSweepLock, releaseSweepLock } from '../utils/sweepLock'
import { isBillingEnabled } from '../utils/billingMode'

// Team / Business budget alerts (80 % / 100 % of the month's pooled AI
// budget → email to the workspace admins). Billing on only.

const INTERVAL_MS = 15 * 60 * 1000
const LOCK = 'workspace-budget-alerts'

async function lockedRun(): Promise<void> {
  if (!await acquireSweepLock(LOCK)) return
  try {
    await runWorkspaceBudgetAlerts()
  } catch (e) {
    console.warn(`[workspace-budget-alerts] skipped: ${e instanceof Error ? e.message : e}`)
  } finally {
    await releaseSweepLock(LOCK)
  }
}

export default defineNitroPlugin((nitroApp) => {
  if (!isBillingEnabled()) return
  const config = useRuntimeConfig()
  if (!config.litellm?.url || !config.litellm?.masterKey) return
  void (async () => {
    await migrationsComplete
    await lockedRun()
  })()
  const timer = setInterval(() => {
    void lockedRun()
  }, INTERVAL_MS)
  nitroApp.hooks.hook('close', () => clearInterval(timer))
})
