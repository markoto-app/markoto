import { and, asc, count, eq, gt, isNotNull, isNull, lt } from 'drizzle-orm'
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
//   launch  → one email per confirmed row, each row deleted right after its
//             email went out; unconfirmed rows deleted unsent
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

/** Confirmed and unconfirmed sign-ups, for the launch sender's report (never addresses). */
export async function countWaitlistSignups(_by: SystemActor): Promise<{ confirmed: number, unconfirmed: number }> {
  const db = useDatabase()
  const [confirmed] = await db.select({ n: count() }).from(waitlistSignups).where(isNotNull(waitlistSignups.confirmedAt))
  const [unconfirmed] = await db.select({ n: count() }).from(waitlistSignups).where(isNull(waitlistSignups.confirmedAt))
  return { confirmed: Number(confirmed?.n ?? 0), unconfirmed: Number(unconfirmed?.n ?? 0) }
}

export interface WaitlistLaunchRecipient {
  id: number
  email: string
  locale: string
}

/**
 * The next confirmed sign-ups after `afterId`, in id order: the launch
 * sender pages through them with a cursor, so a row whose email failed
 * is left in place and not retried in the same run.
 */
export async function nextConfirmedWaitlistSignups(_by: SystemActor, afterId: number, limit: number): Promise<WaitlistLaunchRecipient[]> {
  const db = useDatabase()
  return db.select({ id: waitlistSignups.id, email: waitlistSignups.email, locale: waitlistSignups.locale })
    .from(waitlistSignups)
    .where(and(isNotNull(waitlistSignups.confirmedAt), gt(waitlistSignups.id, afterId)))
    .orderBy(asc(waitlistSignups.id))
    .limit(limit)
}

/** Delete one sign-up by id (the launch email to it went out). Returns whether a row was deleted. */
export async function deleteWaitlistSignupById(_by: SystemActor, id: number): Promise<boolean> {
  const db = useDatabase()
  const rows = await db.delete(waitlistSignups).where(eq(waitlistSignups.id, id)).returning({ id: waitlistSignups.id })
  return rows.length > 0
}

/** Delete every unconfirmed sign-up (at launch they never get an email). Returns the number deleted. */
export async function deleteUnconfirmedWaitlistSignups(_by: SystemActor): Promise<number> {
  const db = useDatabase()
  const rows = await db.delete(waitlistSignups).where(isNull(waitlistSignups.confirmedAt)).returning({ id: waitlistSignups.id })
  return rows.length
}
