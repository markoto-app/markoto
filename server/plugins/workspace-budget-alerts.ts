import { migrationsComplete } from '../utils/platform/migrations'
import { runWorkspaceBudgetAlerts } from '../utils/billing/workspaceBudgetAlerts'
import { acquireSweepLock, releaseSweepLock } from '../utils/platform/sweepLock'
import { isBillingEnabled } from '../utils/billing/billingMode'
import { SWEEPS } from '../config/sweeps'

// Team / Business budget alerts (80 % / 100 % of the month's pooled AI
// budget → email to the workspace admins). Billing on only.

const { intervalMs: INTERVAL_MS } = SWEEPS.workspaceBudgetAlerts
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
