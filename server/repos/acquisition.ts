import { and, eq, isNull, sql } from 'drizzle-orm'
import { users } from '../db/schema'
import { useDatabase } from '../db/client'
import type { UserScope } from './proofs'
import { parseAcquisitionSource, type AcquisitionSource } from '~~/shared/analytics/acquisition'

// The account side of the acquisition funnel (shared/analytics/acquisition.ts):
// which site brought a new account, and when it first opened a checkout.
// Both are written once and never overwritten.

/** The account's stored source; null = direct or unknown. */
export async function getAccountAcquisitionSource(self: UserScope): Promise<AcquisitionSource | null> {
  const row = (await useDatabase().select({ source: users.acquisitionSource }).from(users).where(eq(users.id, self.userId)).limit(1))[0]
  return parseAcquisitionSource(row?.source)
}

/** Store the source of a new account; false when one was already stored. */
export async function recordAccountAcquisitionSource(self: UserScope, source: AcquisitionSource): Promise<boolean> {
  const rows = await useDatabase().update(users)
    .set({ acquisitionSource: source })
    .where(and(eq(users.id, self.userId), isNull(users.acquisitionSource)))
    .returning({ id: users.id })
  return rows.length > 0
}

/** The first time the account opened a paid checkout (later ones keep the first). */
export async function recordCheckoutStarted(self: UserScope): Promise<void> {
  await useDatabase().update(users)
    .set({ checkoutStartedAt: sql`now()` })
    .where(and(eq(users.id, self.userId), isNull(users.checkoutStartedAt)))
}
