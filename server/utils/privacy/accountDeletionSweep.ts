import * as Sentry from '@sentry/nuxt'
import { listAccountsDueForDeletion } from '../../repos/userDeletionRequests'
import { system } from '../../repos/proofs'
import { executeAccountDeletion } from './accountDeletionExecute'
import { useLogger } from '../platform/logger'

const log = useLogger('account-deletion')

// Sweeper that drives the cascading deletion. Runs hourly, advisory-
// locked at the plugin level. Reads users whose grace window has
// elapsed and runs the executor per row.
//
// **Per-user isolation.** A failure on user N must not block user
// N+1. We try-catch the executor per row, log + Sentry on failure,
// and keep going. The user row stays in `deletion_requested_at IS
// NOT NULL` until the executor commits its `DELETE FROM users`, so
// the next sweep run picks up failed rows automatically.
//
// **Failure modes worth thinking about**:
//   - S3 / sync-server down: `deleteDocument` swallows S3 errors
//     (orphan-cleanup catches up); sync-notify is fire-and-forget.
//     The DB cascade still completes.
//   - Stripe down: post-commit; doesn't block. Logged.
//   - Postgres down: the executor throws, the user row stays, we
//     retry next sweep.
//   - A specific row corruption (e.g. a doc with a broken FK):
//     the executor re-throws on the offending step; we log + skip
//     to the next user. The bad user gets retried indefinitely
//     until ops intervenes — and Sentry surfaces it loudly.

export interface DeletionSweepResult {
  scanned: number
  succeeded: number
  failed: number
  failedUserIds: number[]
}

/**
 * Run one sweep pass. Returns counts so the plugin's notifier (or
 * tests) can assert behaviour.
 */
export async function runAccountDeletionSweep(): Promise<DeletionSweepResult> {
  const due = (await listAccountsDueForDeletion(system('account-deletion-sweep'))).map(id => ({ id }))

  const result: DeletionSweepResult = {
    scanned: due.length,
    succeeded: 0,
    failed: 0,
    failedUserIds: []
  }

  for (const row of due) {
    try {
      await executeAccountDeletion({ userId: row.id })
      result.succeeded += 1
    } catch (e) {
      result.failed += 1
      result.failedUserIds.push(row.id)
      log.error('account deletion failed', { userId: row.id, err: e })
      Sentry.captureException(e, {
        tags: {
          component: 'accountDeletionSweep',
          event: 'execute_failed',
          userId: String(row.id)
        }
      })
    }
  }

  if (result.scanned > 0) {
    log.info('account deletion sweep finished', { scanned: result.scanned, succeeded: result.succeeded, failed: result.failed })
  }

  return result
}
