import { deleteExpiredUnconfirmedWaitlistSignups } from '../../repos/waitlist'
import { system } from '../../repos/proofs'
import { useLogger } from '../platform/logger'

const log = useLogger('waitlist-sweep')

// Waitlist sweeper. Deletes unconfirmed sign-ups whose 7-day confirm
// window has passed: the privacy policy promises "unconfirmed entries
// are deleted after 7 days" and this is what keeps that true.
//
// Runs regardless of the billing mode: rows created while the waitlist
// was open must still be reaped after the flag flips. Idempotent, an
// already-deleted row simply doesn't match.

export interface WaitlistSweepResult {
  deletedUnconfirmed: number
}

export async function runWaitlistSweep(now: Date = new Date()): Promise<WaitlistSweepResult> {
  const deletedUnconfirmed = await deleteExpiredUnconfirmedWaitlistSignups(system('waitlist-sweep'), now)
  if (deletedUnconfirmed > 0) {
    log.info('deleted unconfirmed sign-ups past the confirm window', { deleted: deletedUnconfirmed })
  }
  return { deletedUnconfirmed }
}
