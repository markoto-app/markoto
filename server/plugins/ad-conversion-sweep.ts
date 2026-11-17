import { runAdConversionSweep } from '../utils/analytics/adConversionSweep'
import { defineSweeper } from '../utils/platform/defineSweeper'
import { SWEEPS } from '../config/sweeps'

// Hourly: retention + waitlist confirmations + (dry-run) Google Ads upload
// of click-id conversions. Logic in `server/utils/analytics/adConversionSweep.ts`.

export default defineSweeper({
  name: 'ad-conversion-sweep',
  schedule: SWEEPS.adConversions,
  run: runAdConversionSweep
})
