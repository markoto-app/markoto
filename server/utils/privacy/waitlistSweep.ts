import { deleteExpiredUnconfirmedWaitlistSignups } from '../../repos/waitlist'

// Waitlist sweeper. Deletes unconfirmed sign-ups whose 7-day confirm
// window has passed — the privacy policy promises "unconfirmed entries
// are deleted after 7 days" and this is what keeps that true.
//
// Runs regardless of the billing mode: rows created while the waitlist
// was open must still be reaped after the flag flips. Idempotent — an
// already-deleted row simply doesn't match.

export interface WaitlistSweepResult {
  deletedUnconfirmed: number
}

export async function runWaitlistSweep(now: Date = new Date()): Promise<WaitlistSweepResult> {
  const deletedUnconfirmed = await deleteExpiredUnconfirmedWaitlistSignups(now)
  if (deletedUnconfirmed > 0) {
    console.log(`[waitlist-sweep] deleted ${deletedUnconfirmed} unconfirmed sign-up(s) past the confirm window`)
  }
  return { deletedUnconfirmed }
}
