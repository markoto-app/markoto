import { runCreditSettlement } from '../utils/billing/aiCredits'
import { defineSweeper } from '../utils/platform/defineSweeper'
import { isBillingEnabled } from '../utils/billing/billingMode'
import { SWEEPS } from '../config/sweeps'

// AI credit top-ups: hourly, expire grants older than 12 months,
// take each month's AI spend above the plan budget from the credits, and
// push every affected budget to LiteLLM. Billing on only.

export default defineSweeper({
  name: 'ai-credit-settlement',
  schedule: SWEEPS.aiCreditSettlement,
  enabled: isBillingEnabled,
  // A LiteLLM that is still starting fails the run; the next one retries.
  reportErrors: false,
  run: runCreditSettlement
})
