import { runSpendLogsSweep } from '../utils/litellm/spendLogsSweep'
import { defineSweeper } from '../utils/platform/defineSweeper'
import { SWEEPS } from '../config/sweeps'

// LiteLLM_SpendLogs retention: daily, not hourly — the table grows by one row
// per billable AI call, so a day's growth is bounded and hourly runs would
// only add log noise. Revisit if 24h of growth ever approaches the 90-day total.

export default defineSweeper({
  name: 'spend-logs-sweep',
  schedule: SWEEPS.spendLogs,
  run: runSpendLogsSweep
})
