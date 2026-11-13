import { reconcileUserKeys } from '../utils/litellm/keyReconcile'
import { reconcileWorkspaceTeams } from '../utils/litellm/workspaceTeams'
import { useEnv } from '~~/shared/env/load'
import { defineSweeper } from '../utils/platform/defineSweeper'
import { SWEEPS } from '../config/sweeps'

// Brings every existing LiteLLM virtual key in line with its user's plan:
// free-tier pool membership (NUXT_FREE_TIER_TOTAL_BUDGET_USD), max_budget
// (TIER_*_LITELLM_BUDGET_USD) and the monthly reset. Runs once at boot,
// so a config change reaches existing keys on the next deploy, and every
// 6 h as a safety net. Idempotent; logic in `utils/litellm/keyReconcile.ts`.

export default defineSweeper({
  name: 'litellm-key-reconcile',
  schedule: SWEEPS.litellmKeyReconcile,
  enabled: () => {
    const { litellm } = useEnv()
    return Boolean(litellm.url && litellm.masterKey)
  },
  // The proxy may still be starting (boot order), the next run retries.
  reportErrors: false,
  run: async () => {
    const users = await reconcileUserKeys()
    // Team / Business workspace teams + member keys.
    const workspaces = await reconcileWorkspaceTeams()
    return { users, workspaces }
  }
})
