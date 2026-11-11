import { migrationsComplete } from '../utils/platform/migrations'
import { runCreditSettlement } from '../utils/billing/aiCredits'
import { acquireSweepLock, releaseSweepLock } from '../utils/platform/sweepLock'
import { isBillingEnabled } from '../utils/billing/billingMode'

// AI credit top-ups (WP4): hourly — expire grants older than 12 months,
// take each month's AI spend above the plan budget from the credits, and
// push every affected budget to LiteLLM. Billing on only.

const INTERVAL_MS = 60 * 60 * 1000
const LOCK = 'ai-credit-settlement'

async function lockedRun(): Promise<void> {
  if (!await acquireSweepLock(LOCK)) return
  try {
    await runCreditSettlement()
  } catch (e) {
    console.warn(`[ai-credit-settlement] skipped: ${e instanceof Error ? e.message : e}`)
  } finally {
    await releaseSweepLock(LOCK)
  }
}

export default defineNitroPlugin((nitroApp) => {
  if (!isBillingEnabled()) return
  void (async () => {
    await migrationsComplete
    await lockedRun()
  })()
  const timer = setInterval(() => {
    void lockedRun()
  }, INTERVAL_MS)
  nitroApp.hooks.hook('close', () => clearInterval(timer))
})
