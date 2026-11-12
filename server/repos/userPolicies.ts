import { eq, sql } from 'drizzle-orm'
import { users } from '../db/schema'
import { useDatabase } from '../db/client'
import type { UserScope } from './proofs'

// Policy acceptance on the user row (onboarding: age + Privacy + ToS; the
// DPA for workspace owners) and the account-status read of the privacy
// settings page.

/**
 * Convenience read for the account-status endpoint. Returns the
 * minimum the UI needs to render the privacy / settings surface
 * without a second round-trip per row.
 */
export interface AccountStatus {
  email: string | null
  locale: string | null
  ageConfirmedAt: Date | null
  deletionRequestedAt: Date | null
  deletionGraceUntil: Date | null
  privacyVersionAccepted: number | null
  privacyVersionAcceptedLocale: string | null
  tosVersionAccepted: number | null
  tosVersionAcceptedLocale: string | null
  dpaVersionAccepted: number | null
  dpaVersionAcceptedLocale: string | null
}

/**
 * One-shot onboarding mutation: confirm age (if not already) and record Privacy
 * + ToS acceptance at the given versions with the locale they were read in.
 * Idempotent. DPA acceptance is separate (`applyDpaAcceptance`): it is
 * workspace-owner only and prompted at workspace creation.
 */
export async function applyOnboardingAcceptance(self: UserScope, args: {
  privacyVersion: number
  tosVersion: number
  locale: string
}): Promise<void> {
  const db = useDatabase()
  await db.update(users)
    .set({
      ageConfirmedAt: sql`COALESCE(${users.ageConfirmedAt}, now())`,
      privacyVersionAccepted: args.privacyVersion,
      privacyVersionAcceptedLocale: args.locale,
      tosVersionAccepted: args.tosVersion,
      tosVersionAcceptedLocale: args.locale
    })
    .where(eq(users.id, self.userId))
}

/** Record acceptance of the DPA at the given version + locale. */
export async function applyDpaAcceptance(self: UserScope, args: {
  dpaVersion: number
  locale: string
}): Promise<void> {
  const db = useDatabase()
  await db.update(users)
    .set({
      dpaVersionAccepted: args.dpaVersion,
      dpaVersionAcceptedLocale: args.locale
    })
    .where(eq(users.id, self.userId))
}

export async function getAccountStatus(userId: number): Promise<AccountStatus | null> {
  const db = useDatabase()
  const row = (await db
    .select({
      email: users.email,
      locale: users.locale,
      ageConfirmedAt: users.ageConfirmedAt,
      deletionRequestedAt: users.deletionRequestedAt,
      deletionGraceUntil: users.deletionGraceUntil,
      privacyVersionAccepted: users.privacyVersionAccepted,
      privacyVersionAcceptedLocale: users.privacyVersionAcceptedLocale,
      tosVersionAccepted: users.tosVersionAccepted,
      tosVersionAcceptedLocale: users.tosVersionAcceptedLocale,
      dpaVersionAccepted: users.dpaVersionAccepted,
      dpaVersionAcceptedLocale: users.dpaVersionAcceptedLocale
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1))[0]
  return row ?? null
}
