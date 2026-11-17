import { and, desc, eq, lt } from 'drizzle-orm'
import { taxEvidence } from '../db/schema'
import { executor, type TxHandle } from '../db/client'
import type { SystemActor, UserScope } from './proofs'

// Location evidence of sales (`tax_evidence`). Written by the Stripe
// webhook; orchestration in `server/utils/billing/taxEvidence.ts`.

export type TaxEvidenceRow = typeof taxEvidence.$inferSelect
export type TaxEvidenceInsert = Omit<typeof taxEvidence.$inferInsert, 'id' | 'createdAt'>
export type TaxIdVerification = NonNullable<TaxEvidenceRow['taxIdVerification']>

/** Record a sale's evidence once per Checkout / invoice. False when it was already recorded. */
export async function insertTaxEvidence(_by: SystemActor, row: TaxEvidenceInsert, tx?: TxHandle): Promise<boolean> {
  const inserted = await executor(tx).insert(taxEvidence).values(row)
    .onConflictDoNothing({ target: taxEvidence.stripeObjectId })
    .returning({ id: taxEvidence.id })
  return inserted.length > 0
}

/** The government check of a customer's tax ID finished (or the ID was removed after failing it). */
export async function updateTaxIdVerification(
  _by: SystemActor,
  args: { customerId: string, taxIdValue: string, taxIdStripeId: string, status: TaxIdVerification, removedAt?: Date | null },
  tx?: TxHandle
): Promise<number> {
  const set: Partial<TaxEvidenceRow> = { taxIdVerification: args.status, taxIdStripeId: args.taxIdStripeId }
  if (args.removedAt) set.taxIdRemovedAt = args.removedAt
  const rows = await executor(tx).update(taxEvidence).set(set)
    .where(and(eq(taxEvidence.stripeCustomerId, args.customerId), eq(taxEvidence.taxIdValue, args.taxIdValue)))
    .returning({ id: taxEvidence.id })
  return rows.length
}

/** The newest evidence row of a customer (subject and country for alerts). */
export async function latestTaxEvidenceForCustomer(_by: SystemActor, customerId: string, tx?: TxHandle): Promise<TaxEvidenceRow | null> {
  const rows = await executor(tx).select().from(taxEvidence)
    .where(eq(taxEvidence.stripeCustomerId, customerId))
    .orderBy(desc(taxEvidence.createdAt))
    .limit(1)
  return rows[0] ?? null
}

/** The user's own purchases' evidence (data export). */
export async function listTaxEvidenceForUser(self: UserScope, tx?: TxHandle): Promise<TaxEvidenceRow[]> {
  return executor(tx).select().from(taxEvidence)
    .where(and(eq(taxEvidence.subjectType, 'user'), eq(taxEvidence.subjectId, String(self.userId))))
    .orderBy(desc(taxEvidence.createdAt))
}

/**
 * Account deletion: the VAT record stays (10-year retention), the link to
 * the account goes. Returns the number of rows detached.
 */
export async function detachTaxEvidenceFromUser(self: UserScope, tx?: TxHandle): Promise<number> {
  const rows = await executor(tx).update(taxEvidence).set({ subjectId: null })
    .where(and(eq(taxEvidence.subjectType, 'user'), eq(taxEvidence.subjectId, String(self.userId))))
    .returning({ id: taxEvidence.id })
  return rows.length
}

/** Retention: delete rows recorded before `before`. */
export async function pruneTaxEvidence(_by: SystemActor, before: Date, tx?: TxHandle): Promise<number> {
  const rows = await executor(tx).delete(taxEvidence).where(lt(taxEvidence.createdAt, before)).returning({ id: taxEvidence.id })
  return rows.length
}
