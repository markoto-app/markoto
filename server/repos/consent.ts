import { and, desc, eq } from 'drizzle-orm'
import { consentLog } from '../db/schema'
import { useDatabase } from '../db/client'
import type { UserScope } from './proofs'

// `consent_log`: append-only consent decisions of a visitor, keyed on their
// account (`self`) or, signed out, on their own first-party anonymous
// cookie id. There is no update path; the newest row per purpose is the
// current state.

type ConsentRow = typeof consentLog.$inferInsert

/** The visitor's newest decision on `purpose` (their account when signed in, else their cookie). */
export async function latestConsentDecision(
  visitor: { self: UserScope | null, anonId: string },
  purpose: ConsentRow['purpose']
): Promise<{ granted: boolean, version: number } | null> {
  const match = visitor.self === null ? eq(consentLog.anonId, visitor.anonId) : eq(consentLog.userId, visitor.self.userId)
  return (await useDatabase()
    .select({ granted: consentLog.granted, version: consentLog.version })
    .from(consentLog)
    .where(and(match, eq(consentLog.purpose, purpose)))
    .orderBy(desc(consentLog.createdAt))
    .limit(1))[0] ?? null
}

/** Append the visitor's decisions (one row each). */
export async function appendConsentDecisions(
  visitor: { self: UserScope | null, anonId: string },
  rows: ReadonlyArray<Omit<ConsentRow, 'userId' | 'anonId'>>
): Promise<void> {
  if (rows.length === 0) return
  await useDatabase().insert(consentLog).values(rows.map(r => ({ ...r, userId: visitor.self?.userId ?? null, anonId: visitor.anonId })))
}
