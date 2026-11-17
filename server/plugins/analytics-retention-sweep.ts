import { analyticsEnabled, runUmamiRetentionSweep } from '../utils/analytics/umamiRetentionSweep'
import { defineSweeper } from '../utils/platform/defineSweeper'
import { SWEEPS } from '../config/sweeps'

// Daily: deletes Umami visitor data past its retention (only where
// analytics is configured). Logic in `server/utils/analytics/umamiRetentionSweep.ts`.

export default defineSweeper({
  name: 'analytics-retention-sweep',
  schedule: SWEEPS.analyticsRetention,
  enabled: analyticsEnabled,
  run: runUmamiRetentionSweep
})
