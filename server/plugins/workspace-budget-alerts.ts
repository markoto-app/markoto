import { runWorkspaceBudgetAlerts } from '../utils/billing/workspaceBudgetAlerts'
import { defineSweeper } from '../utils/platform/defineSweeper'
import { isBillingEnabled } from '../utils/billing/billingMode'
import { SWEEPS } from '../config/sweeps'

// Team / Business budget alerts (80 % / 100 % of the month's pooled AI
// budget → email to the workspace admins). Billing on only, and only with a
// LiteLLM to read spend from.

export default defineSweeper({
  name: 'workspace-budget-alerts',
  schedule: SWEEPS.workspaceBudgetAlerts,
  enabled: () => {
    if (!isBillingEnabled()) return false
    const config = useRuntimeConfig()
    return Boolean(config.litellm?.url && config.litellm?.masterKey)
  },
  // A LiteLLM that is still starting fails the run; the next one retries.
  reportErrors: false,
  run: runWorkspaceBudgetAlerts
})
