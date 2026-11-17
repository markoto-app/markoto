import { runAiSpendRollup } from '../utils/litellm/aiSpendRollup'
import { defineSweeper } from '../utils/platform/defineSweeper'
import { SWEEPS } from '../config/sweeps'

// AI cost rollup without user identifiers (`ai_spend_daily`), filled from
// LiteLLM's spend logs while they still exist. Every 6 hours, so a day is
// rolled up long before `spend-logs-sweep` deletes its raw rows.

export default defineSweeper({
  name: 'ai-spend-rollup',
  schedule: SWEEPS.aiSpendRollup,
  run: () => runAiSpendRollup()
})
