import { and, eq, gt, isNull, lt } from 'drizzle-orm'
import { waitlistSignups } from '../db/schema'
import { useDatabase } from '../db/client'
import type { SystemActor, UserScope } from './proofs'

// `waitlist_signups` repository: the paid-plans waitlist.
//
// Every function takes token HASHES, never raw tokens: hashing lives in
// `server/utils/privacy/waitlist.ts` so the raw value never reaches this layer
// (and therefore never reaches a query log). Emails arrive already
// normalised (`normaliseWaitlistEmail`).
//
// Lifecycle:
//   signup  → row inserted UNCONFIRMED with confirm + unsubscribe hashes
//   re-signup while unconfirmed → tokens rotated, a fresh email goes out
//   re-signup while confirmed   → no-op (caller sends nothing)
//   confirm → `confirmed_at` set, confirm hash cleared (single use)
//   unsubscribe → row DELETED (consent withdrawn: we keep nothing)
//   sweep   → unconfirmed rows past their confirm window deleted
//   account deletion → FK `ON DELETE CASCADE` on `user_id`

export interface WaitlistSignupInput {
  email: string
  locale: string
  consentVersion: number
  consentTextId: string
  userId: number | null
  confirmTokenHash: string
  confirmTokenExpiresAt: Date
  unsubscribeTokenHash: string
}

// `unchanged` = nothing to send: the row is already confirmed, or a
// concurrent first-time signup for the same address won the insert
// (that request sends the email).
export type WaitlistUpsertOutcome = 'created' | 'refreshed' | 'unchanged'

/**
 * Insert a new unconfirmed signup, or rotate the tokens of an existing
 * unconfirmed one. An already-confirmed row is left untouched (the
 * caller then sends no email, so a third party re-submitting someone
 * else's address can't spam them past the first confirmation).
 *
 * Serialised per email via `SELECT … FOR UPDATE` inside one
 * transaction. Two concurrent FIRST-time signups for the same address
 * both see no row; `ON CONFLICT DO NOTHING` on the `email` UNIQUE
 * constraint makes the loser a no-op (`unchanged`) instead of a
 * unique-violation error.
 */
export async function upsertWaitlistSignup(input: WaitlistSignupInput): Promise<WaitlistUpsertOutcome> {
  const db = useDatabase()
  return await db.transaction(async (tx) => {
    const existing = (await tx
      .select({ id: waitlistSignups.id, confirmedAt: waitlistSignups.confirmedAt, userId: waitlistSignups.userId })
      .from(waitlistSignups)
      .where(eq(waitlistSignups.email, input.email))
      .for('update')
      .limit(1))[0]

    if (!existing) {
      const inserted = await tx.insert(waitlistSignups).values({
        email: input.email,
        locale: input.locale,
        consentVersion: input.consentVersion,
        consentTextId: input.consentTextId,
        userId: input.userId,
        confirmTokenHash: input.confirmTokenHash,
        confirmTokenExpiresAt: input.confirmTokenExpiresAt,
        unsubscribeTokenHash: input.unsubscribeTokenHash
      }).onConflictDoNothing({ target: waitlistSignups.email }).returning({ id: waitlistSignups.id })
      return inserted.length > 0 ? 'created' : 'unchanged'
    }

    if (existing.confirmedAt !== null) return 'unchanged'

    // Unconfirmed re-signup: the person may have lost the first email.
    // Rotate both tokens (old links stop working) and record the
    // consent text they agreed to THIS time. Keep an existing account
    // link; only fill it if it was empty.
    await tx.update(waitlistSignups)
      .set({
        locale: input.locale,
        consentVersion: input.consentVersion,
        consentTextId: input.consentTextId,
        userId: existing.userId ?? input.userId,
        confirmTokenHash: input.confirmTokenHash,
        confirmTokenExpiresAt: input.confirmTokenExpiresAt,
        unsubscribeTokenHash: input.unsubscribeTokenHash
      })
      .where(eq(waitlistSignups.id, existing.id))
    return 'refreshed'
  })
}

/**
 * Confirm the signup whose confirm-token hash matches, if it hasn't
 * expired. Single use: the hash is cleared on success. Returns whether
 * a row was confirmed.
 */
export async function confirmWaitlistSignup(confirmTokenHash: string, now: Date = new Date()): Promise<boolean> {
  const db = useDatabase()
  const rows = await db.update(waitlistSignups)
    .set({ confirmedAt: now, confirmTokenHash: null, confirmTokenExpiresAt: null })
    .where(and(
      eq(waitlistSignups.confirmTokenHash, confirmTokenHash),
      isNull(waitlistSignups.confirmedAt),
      gt(waitlistSignups.confirmTokenExpiresAt, now)
    ))
    .returning({ id: waitlistSignups.id })
  return rows.length > 0
}

/**
 * Delete the signup whose unsubscribe-token hash matches (confirmed or
 * not). Returns whether a row was deleted.
 */
export async function deleteWaitlistSignupByUnsubscribeToken(unsubscribeTokenHash: string): Promise<boolean> {
  const db = useDatabase()
  const rows = await db.delete(waitlistSignups)
    .where(eq(waitlistSignups.unsubscribeTokenHash, unsubscribeTokenHash))
    .returning({ id: waitlistSignups.id })
  return rows.length > 0
}

// `type` (not `interface`) so rows are assignable to `Record<string, unknown>`
// for the NDJSON writer in dataExport.ts.
export type WaitlistSignupExport = {
  email: string
  locale: string
  consentVersion: number
  consentTextId: string
  createdAt: string
  confirmedAt: string | null
}

/**
 * The signups linked to a user, for the GDPR data export. Explicit
 * projection: token hashes are internal secrets, not personal data
 * the person needs, and exporting them would only widen their exposure.
 */
export async function listWaitlistSignupsForUser(user: UserScope): Promise<WaitlistSignupExport[]> {
  const userId = user.userId
  const db = useDatabase()
  const rows = await db.select({
    email: waitlistSignups.email,
    locale: waitlistSignups.locale,
    consentVersion: waitlistSignups.consentVersion,
    consentTextId: waitlistSignups.consentTextId,
    createdAt: waitlistSignups.createdAt,
    confirmedAt: waitlistSignups.confirmedAt
  }).from(waitlistSignups).where(eq(waitlistSignups.userId, userId))
  return rows.map(r => ({
    email: r.email,
    locale: r.locale,
    consentVersion: r.consentVersion,
    consentTextId: r.consentTextId,
    createdAt: r.createdAt.toISOString(),
    confirmedAt: r.confirmedAt?.toISOString() ?? null
  }))
}

/**
 * Delete unconfirmed signups whose confirm window has passed. Returns
 * the number of rows removed (sweeper telemetry).
 */
export async function deleteExpiredUnconfirmedWaitlistSignups(_by: SystemActor, now: Date = new Date()): Promise<number> {
  const db = useDatabase()
  const rows = await db.delete(waitlistSignups)
    .where(and(
      isNull(waitlistSignups.confirmedAt),
      lt(waitlistSignups.confirmTokenExpiresAt, now)
    ))
    .returning({ id: waitlistSignups.id })
  return rows.length
}
