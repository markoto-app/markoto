import { migrationsComplete } from '../utils/migrations'
import { reconcileUserKeys } from '../utils/litellm/keyReconcile'
import { reconcileWorkspaceTeams } from '../utils/litellm/workspaceTeams'
import { freeTierTotalBudgetProblems } from '../utils/litellm/freeTierTeam'
import { acquireSweepLock, releaseSweepLock } from '../utils/sweepLock'

// Brings every existing LiteLLM virtual key in line with its user's plan:
// free-tier pool membership (NUXT_FREE_TIER_TOTAL_BUDGET_USD), max_budget
// (TIER_*_LITELLM_BUDGET_USD) and the monthly reset. Runs once at boot —
// so a config change reaches existing keys on the next deploy — and every
// 6 h as a safety net. Idempotent; logic in `utils/litellm/keyReconcile.ts`.

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6h
const LOCK = 'litellm-key-reconcile'

async function lockedRun(): Promise<void> {
  if (!await acquireSweepLock(LOCK)) return
  try {
    await reconcileUserKeys()
    // Team / Business workspace teams + member keys (WP3).
    await reconcileWorkspaceTeams()
  } catch (e) {
    // The proxy may still be starting (boot order) — the next run retries.
    console.warn(`[litellm-key-reconcile] skipped: ${e instanceof Error ? e.message : e}`)
  } finally {
    await releaseSweepLock(LOCK)
  }
}

export default defineNitroPlugin((nitroApp) => {
  const config = useRuntimeConfig()
  if (!config.litellm?.url || !config.litellm?.masterKey) return
  for (const problem of freeTierTotalBudgetProblems()) console.warn(`[litellm-key-reconcile] ${problem}`)

  void (async () => {
    await migrationsComplete
    await lockedRun()
  })()

  const timer = setInterval(() => {
    void lockedRun()
  }, SWEEP_INTERVAL_MS)
  nitroApp.hooks.hook('close', () => clearInterval(timer))
})
