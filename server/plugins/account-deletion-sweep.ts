import { runAccountDeletionSweep } from '../utils/privacy/accountDeletionSweep'
import { defineSweeper } from '../utils/platform/defineSweeper'
import { SWEEPS } from '../config/sweeps'

// Cascading purge for users whose 30-day grace window has elapsed. The heavy
// lifting is in `accountDeletionSweep.ts` so tests can import it directly.
//
// Hourly: the sweep only acts on users whose grace window has elapsed, so the
// interval just controls how soon after the cutoff the cascade fires.
//
// The lock: the executor is row-level idempotent, but two instances racing on
// the same user would produce a flurry of "user not found" errors.

export default defineSweeper({
  name: 'account-deletion-sweep',
  schedule: SWEEPS.accountDeletion,
  run: async () => {
    const result = await runAccountDeletionSweep()
    return result.scanned > 0 ? result : undefined
  }
})
