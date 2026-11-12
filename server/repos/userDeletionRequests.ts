import { and, eq, isNotNull, lte, sql } from 'drizzle-orm'
import type { SystemActor, UserScope } from './proofs'
import { users } from '../db/schema'
import { useDatabase } from '../db/client'
import { ConflictError } from './errors'

// GDPR Art. 17 account-deletion request lifecycle. These functions only touch
// the two timestamp columns on `users`; the cascading purge lives in
// `accountDeletionSweep.ts`.
//
// `requestAccountDeletion` throws `ConflictError` (409) on an already-scheduled
// account instead of being silently idempotent: re-requesting would reset the
// grace clock, and someone with a phished session could keep extending the
// window. `cancelAccountDeletion` throws `ConflictError` when nothing is
// scheduled. `getAccountDeletionStatus` reads the state (null fields = none
// scheduled).

export interface AccountDeletionStatus {
  deletionRequestedAt: Date | null
  deletionGraceUntil: Date | null
}

/**
 * Schedule the user's account for deletion. Sets
 * `deletion_requested_at = now()` + `deletion_grace_until = now() +
 * graceDays`. Throws `ConflictError` if the row already has a
 * scheduled deletion; the caller (orchestrator → endpoint) translates
 * to 409 so the client can surface "already scheduled" without a
 * duplicated audit trail.
 */
export async function requestAccountDeletion(self: UserScope, graceDays: number): Promise<AccountDeletionStatus> {
  const userId = self.userId
  if (!Number.isInteger(graceDays) || graceDays < 1 || graceDays > 365) {
    // Repo-level shape rejection — should never trip from a controlled
    // caller (orchestrator passes the constant), but guard anyway so a
    // misconfigured config can't put a 1000-year grace into the DB.
    throw new Error(`requestAccountDeletion: graceDays out of range: ${graceDays}`)
  }

  const db = useDatabase()
  // Single UPDATE with a WHERE that excludes already-scheduled rows.
  // Using `RETURNING` lets us distinguish "row updated" (success) from
  // "row not updated" (already scheduled OR user gone). We follow up
  // with a status-read on the no-rows-updated branch to disambiguate.
  const updated = await db.update(users)
    .set({
      deletionRequestedAt: sql`now()`,
      deletionGraceUntil: sql`now() + (${graceDays}::int * interval '1 day')`
    })
    .where(and(
      eq(users.id, userId),
      // ONLY update if not already scheduled. This is the race-free
      // "first request wins" guard — concurrent duplicate requests
      // serialise via row-locking and the second one sees the
      // already-set column and matches zero rows.
      sql`${users.deletionRequestedAt} IS NULL`
    ))
    .returning({
      deletionRequestedAt: users.deletionRequestedAt,
      deletionGraceUntil: users.deletionGraceUntil
    })

  const [row] = updated
  if (row && updated.length === 1) {
    return {
      deletionRequestedAt: row.deletionRequestedAt,
      deletionGraceUntil: row.deletionGraceUntil
    }
  }

  // No row updated. Distinguish "already scheduled" (409) from "user
  // doesn't exist" (404 — but `requireValidatedUserSession` should
  // have ruled this out before we get here).
  const status = await getAccountDeletionStatus(self)
  if (status === null) {
    throw new Error(`requestAccountDeletion: user ${userId} not found`)
  }
  if (status.deletionRequestedAt !== null) {
    throw new ConflictError('account deletion already scheduled')
  }
  // Should be unreachable — same row both unscheduled AND not updated
  // means a bug. Surface loudly.
  throw new Error('requestAccountDeletion: unexpected row state')
}

/**
 * Cancel a scheduled deletion. Clears both timestamp columns. Throws
 * `ConflictError` if no deletion is scheduled.
 */
export async function cancelAccountDeletion(self: UserScope): Promise<void> {
  const userId = self.userId
  const db = useDatabase()
  const updated = await db.update(users)
    .set({
      deletionRequestedAt: null,
      deletionGraceUntil: null
    })
    .where(and(
      eq(users.id, userId),
      isNotNull(users.deletionRequestedAt)
    ))
    .returning({ id: users.id })

  if (updated.length === 1) return

  // No row updated — disambiguate.
  const status = await getAccountDeletionStatus(self)
  if (status === null) {
    throw new Error(`cancelAccountDeletion: user ${userId} not found`)
  }
  throw new ConflictError('no account deletion to cancel')
}

/**
 * Read the deletion-request state for a user. Returns null if the
 * user does not exist; the two timestamp columns are null when no
 * deletion is scheduled.
 */
export async function getAccountDeletionStatus(self: UserScope): Promise<AccountDeletionStatus | null> {
  const userId = self.userId
  const db = useDatabase()
  const row = (await db
    .select({
      deletionRequestedAt: users.deletionRequestedAt,
      deletionGraceUntil: users.deletionGraceUntil
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1))[0]
  if (!row) return null
  return {
    deletionRequestedAt: row.deletionRequestedAt,
    deletionGraceUntil: row.deletionGraceUntil
  }
}

/** Accounts whose deletion grace period has ended (the deletion sweep's work list). */
export async function listAccountsDueForDeletion(_by: SystemActor): Promise<number[]> {
  const rows = await useDatabase()
    .select({ id: users.id })
    .from(users)
    .where(and(isNotNull(users.deletionRequestedAt), isNotNull(users.deletionGraceUntil), lte(users.deletionGraceUntil, sql`now()`)))
  return rows.map(r => r.id)
}
