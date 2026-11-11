import { getSettledUsd, listGrants, sumUsableCredits, type CreditSubject } from '../../repos/aiCreditGrants'

// The part of an AI budget that comes from credit top-ups, USD:
// the credits still usable + the credits already used THIS month. Added
// to the plan budget on the LiteLLM key / team, so a month's budget never
// drops below what was already spent, and resets with LiteLLM's monthly
// reset (on the 1st, UTC) to plan + what's left.
//
// Kept apart from `aiCredits.ts` (settlement, Stripe) so `userKeys.ts`
// and `workspaceTeams.ts` can import it without an import cycle.

/** Calendar month (UTC) as 'YYYY-MM' — LiteLLM's budget period. */
export function creditPeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

/** The month before `creditPeriod(now)`. */
export function previousCreditPeriod(now: Date = new Date()): string {
  return creditPeriod(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)))
}

export async function creditBudgetExtraUsd(subject: CreditSubject, now: Date = new Date()): Promise<number> {
  const [usable, settled] = await Promise.all([
    sumUsableCredits(subject, now),
    getSettledUsd(subject, creditPeriod(now))
  ])
  return Math.round((usable + settled) * 10_000) / 10_000
}

export interface CreditBalanceView {
  /** Credits still usable, USD. */
  usableUsd: number
  /** Credits used this month, USD. */
  usedThisMonthUsd: number
  grants: Array<{ pack: string, amountUsd: number, remainingUsd: number, refundedUsd: number, expiresAt: string, createdAt: string }>
}

/** Balance + purchase history for the billing UIs. */
export async function creditBalanceView(subject: CreditSubject, now: Date = new Date()): Promise<CreditBalanceView> {
  const [usable, used, grants] = await Promise.all([
    sumUsableCredits(subject, now),
    getSettledUsd(subject, creditPeriod(now)),
    listGrants(subject)
  ])
  return {
    usableUsd: usable,
    usedThisMonthUsd: used,
    grants: grants.slice(0, 20).map(g => ({
      pack: g.pack,
      amountUsd: g.amountUsd,
      remainingUsd: g.expiresAt.getTime() > now.getTime() ? g.remainingUsd : 0,
      refundedUsd: g.refundedUsd,
      expiresAt: g.expiresAt.toISOString(),
      createdAt: g.createdAt.toISOString()
    }))
  }
}
