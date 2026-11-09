import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import {
  consumeCredits,
  deleteCreditsForSubject,
  expireGrants,
  getSettledUsd,
  insertCreditGrant,
  listUsableGrants,
  refundCreditGrant,
  settleMonth,
  sumUsableCredits,
  type CreditSubject
} from '../../server/repos/aiCreditGrants'
import { creditBudgetExtraUsd, creditPeriod, previousCreditPeriod } from '../../server/utils/aiCreditBudget'

// AI credit top-ups (WP4): grants, using them up oldest-expiring first,
// monthly settlement, refunds, expiry.

const alice: CreditSubject = { type: 'user', id: '1' }
const ws: CreditSubject = { type: 'workspace', id: 'ws-1' }
let pi = 0

function future(days: number): Date {
  return new Date(Date.now() + days * 24 * 3600 * 1000)
}

async function grant(subject: CreditSubject, usd: number, expiresInDays = 365): Promise<string> {
  const id = `pi_test_${++pi}`
  expect(await insertCreditGrant({ subject, pack: String(usd), amountUsd: usd, amountPaid: usd * 100, currency: 'eur', stripePaymentIntentId: id, stripeCheckoutSessionId: null, expiresAt: future(expiresInDays) })).toBe(true)
  return id
}

describe('AI credit grants', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('records a payment once, per subject', async () => {
    const id = await grant(alice, 10)
    expect(await insertCreditGrant({ subject: alice, pack: '10', amountUsd: 10, amountPaid: 1000, currency: 'eur', stripePaymentIntentId: id, stripeCheckoutSessionId: null, expiresAt: future(365) })).toBe(false)
    await grant(ws, 25)
    expect(await sumUsableCredits(alice)).toBe(10)
    expect(await sumUsableCredits(ws)).toBe(25)
  })

  it('uses the soonest-expiring grant first and records the month', async () => {
    await grant(alice, 10, 300)
    await grant(alice, 10, 30)
    const period = creditPeriod()
    expect(await consumeCredits(alice, period, 12)).toBe(12)
    const grants = await listUsableGrants(alice)
    expect(grants.map(g => g.remainingUsd)).toEqual([8])
    expect(await getSettledUsd(alice, period)).toBe(12)
    // More than is left: takes what there is.
    expect(await consumeCredits(alice, period, 50)).toBe(8)
    expect(await sumUsableCredits(alice)).toBe(0)
  })

  it('settling a month is idempotent: only the difference is taken', async () => {
    await grant(alice, 10)
    const period = creditPeriod()
    expect(await settleMonth(alice, period, 3)).toBe(3)
    expect(await settleMonth(alice, period, 3)).toBe(0)
    expect(await settleMonth(alice, period, 4.5)).toBe(1.5)
    expect(await sumUsableCredits(alice)).toBe(5.5)
    // Budget extra = what's left + what this month already used: stays 10
    // through the month, so spend never exceeds the budget.
    expect(await creditBudgetExtraUsd(alice)).toBe(10)
  })

  it('a refund removes the refunded share of what is left', async () => {
    const id = await grant(alice, 20)
    await consumeCredits(alice, creditPeriod(), 5)
    expect(await refundCreditGrant(id, 0.5)).toEqual(alice)
    expect(await sumUsableCredits(alice)).toBe(5)
    // The same refund again changes nothing; a full refund takes the rest.
    await refundCreditGrant(id, 0.5)
    expect(await sumUsableCredits(alice)).toBe(5)
    await refundCreditGrant(id, 1)
    expect(await sumUsableCredits(alice)).toBe(0)
    expect(await refundCreditGrant('pi_unknown', 1)).toBeNull()
  })

  it('expired grants drop out and report their subject once', async () => {
    await grant(alice, 10, 365)
    const id = await grant(alice, 10, 1)
    await testDb().query(`UPDATE ai_credit_grants SET expires_at = now() - interval '1 day' WHERE stripe_payment_intent_id = $1`, [id])
    expect(await sumUsableCredits(alice)).toBe(10)
    expect(await expireGrants()).toEqual([alice])
    expect(await expireGrants()).toEqual([])
  })

  it('deleting a subject removes its grants and settlements only', async () => {
    await grant(alice, 10)
    await grant(ws, 10)
    await consumeCredits(alice, creditPeriod(), 1)
    expect(await deleteCreditsForSubject(alice)).toBe(1)
    expect(await sumUsableCredits(alice)).toBe(0)
    expect(await getSettledUsd(alice, creditPeriod())).toBe(0)
    expect(await sumUsableCredits(ws)).toBe(10)
  })

  it('periods are calendar months (UTC)', () => {
    expect(creditPeriod(new Date('2027-03-31T23:59:59Z'))).toBe('2027-03')
    expect(previousCreditPeriod(new Date('2027-03-31T23:59:59Z'))).toBe('2027-02')
    expect(previousCreditPeriod(new Date('2027-01-01T00:00:00Z'))).toBe('2026-12')
  })
})
