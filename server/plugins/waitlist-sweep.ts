import { runWaitlistSweep } from '../utils/privacy/waitlistSweep'
import { defineSweeper } from '../utils/platform/defineSweeper'
import { SWEEPS } from '../config/sweeps'

// Hourly sweeper that deletes unconfirmed paid-plans waitlist sign-ups
// past their 7-day confirm window. Logic lives in
// `server/utils/privacy/waitlistSweep.ts` so tests can drive it directly.
// Hourly (not daily) so "deleted after 7 days" is accurate to the hour.

export default defineSweeper({
  name: 'waitlist-sweep',
  schedule: SWEEPS.waitlist,
  run: runWaitlistSweep
})
