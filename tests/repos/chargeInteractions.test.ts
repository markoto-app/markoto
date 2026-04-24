import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import {
  chargeInteractions,
  BudgetExhausted,
  getInteractionsRemaining,
  currentPeriodStart,
  interactionsForAudioMs
} from '../../server/utils/billing'
import { TIERS } from '../../shared/config/tiers'

// Atomic charge semantics — the core of interaction enforcement. These
// tests bypass the TEST_MODE=1 bypass (which skips DB writes entirely)
// via vi.stubEnv so we can exercise the real INSERT ... ON CONFLICT
// path against Postgres.

async function seedUsage(attributedTo: string, periodStart: Date, used: number) {
  const db = testDb()
  await db.query(
    `INSERT INTO ai_usage_period (attributed_to, period_start, interactions_used)
     VALUES ($1, $2, $3)`,
    [attributedTo, periodStart, used]
  )
}

describe('chargeInteractions — atomic increment', () => {
  beforeEach(async () => {
    await resetDb()
    // Unset TEST_MODE for this suite — we want real DB writes.
    vi.stubEnv('TEST_MODE', '')
  })
  afterEach(() => { vi.unstubAllEnvs() })

  it('inserts a new period row when none exists', async () => {
    const result = await chargeInteractions({
      attributedTo: 'user:42', plan: 'pro', delta: 3, periodStart: currentPeriodStart()
    })
    expect(result.used).toBe(3)
    expect(result.remaining).toBe(TIERS.pro.interactionsPerMonth - 3)

    // Row persisted.
    const r = await testDb().query<{ used: number }>(
      `SELECT interactions_used AS used FROM ai_usage_period WHERE attributed_to = 'user:42'`
    )
    expect(r.rows[0].used).toBe(3)
  })

  it('increments an existing period row atomically', async () => {
    const period = currentPeriodStart()
    await seedUsage('user:42', period, 10)
    const result = await chargeInteractions({
      attributedTo: 'user:42', plan: 'pro', delta: 7, periodStart: period
    })
    expect(result.used).toBe(17)
    expect(result.remaining).toBe(TIERS.pro.interactionsPerMonth - 17)
  })

  it('rejects non-positive deltas before touching the DB', async () => {
    const period = currentPeriodStart()
    await expect(
      chargeInteractions({ attributedTo: 'user:42', plan: 'pro', delta: 0, periodStart: period })
    ).rejects.toThrow(/delta must be positive/)
    await expect(
      chargeInteractions({ attributedTo: 'user:42', plan: 'pro', delta: -5, periodStart: period })
    ).rejects.toThrow(/delta must be positive/)
    // DB untouched.
    const r = await testDb().query<{ c: string }>(
      `SELECT COUNT(*) AS c FROM ai_usage_period`
    )
    expect(Number(r.rows[0].c)).toBe(0)
  })

  it('isolates periods — same user across different months counts separately', async () => {
    const apr = new Date(Date.UTC(2026, 3, 1))
    const may = new Date(Date.UTC(2026, 4, 1))
    await chargeInteractions({ attributedTo: 'user:42', plan: 'pro', delta: 20, periodStart: apr })
    await chargeInteractions({ attributedTo: 'user:42', plan: 'pro', delta: 5, periodStart: may })

    // April row still at 20, May row at 5. Reading remaining for May
    // does NOT include the 20 from April.
    const aprRemaining = await getInteractionsRemaining('user:42', 'pro', apr)
    const mayRemaining = await getInteractionsRemaining('user:42', 'pro', may)
    expect(aprRemaining).toBe(TIERS.pro.interactionsPerMonth - 20)
    expect(mayRemaining).toBe(TIERS.pro.interactionsPerMonth - 5)
  })
})

describe('chargeInteractions — BudgetExhausted + rollback', () => {
  beforeEach(async () => {
    await resetDb()
    vi.stubEnv('TEST_MODE', '')
  })
  afterEach(() => { vi.unstubAllEnvs() })

  it('throws BudgetExhausted when the charge would exceed cap', async () => {
    const period = currentPeriodStart()
    // Seed Free tier at 99/100.
    await seedUsage('user:1', period, TIERS.free.interactionsPerMonth - 1)
    // Try to charge 5 → would reach 104 > 100. Must throw + rollback.
    await expect(
      chargeInteractions({ attributedTo: 'user:1', plan: 'free', delta: 5, periodStart: period })
    ).rejects.toThrow(BudgetExhausted)

    // CRITICAL: the counter must NOT have advanced. If the rollback
    // didn't take, the row would be at 104 and we'd have charged a
    // user past their cap. Pin at 99.
    const r = await testDb().query<{ used: number }>(
      `SELECT interactions_used AS used FROM ai_usage_period WHERE attributed_to = 'user:1'`
    )
    expect(r.rows[0].used).toBe(TIERS.free.interactionsPerMonth - 1)
  })

  it('BudgetExhausted carries diagnostic fields (attributedTo, plan, requestedDelta, used, cap)', async () => {
    const period = currentPeriodStart()
    await seedUsage('user:7', period, TIERS.pro.interactionsPerMonth)

    try {
      await chargeInteractions({ attributedTo: 'user:7', plan: 'pro', delta: 1, periodStart: period })
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(BudgetExhausted)
      const err = e as BudgetExhausted
      expect(err.attributedTo).toBe('user:7')
      expect(err.plan).toBe('pro')
      expect(err.requestedDelta).toBe(1)
      expect(err.cap).toBe(TIERS.pro.interactionsPerMonth)
      expect(err.used).toBe(TIERS.pro.interactionsPerMonth)
    }
  })

  it('exactly-at-cap charge succeeds (not off-by-one)', async () => {
    // A charge that lands EXACTLY at cap must succeed — the boundary
    // is "> cap throws", not ">= cap". A user with 99 used charging 1
    // should succeed and be at 100/100.
    const period = currentPeriodStart()
    const cap = TIERS.free.interactionsPerMonth
    await seedUsage('user:2', period, cap - 1)
    const result = await chargeInteractions({
      attributedTo: 'user:2', plan: 'free', delta: 1, periodStart: period
    })
    expect(result.used).toBe(cap)
    expect(result.remaining).toBe(0)
  })

  it('a second charge after BudgetExhausted still throws (state didn\'t drift)', async () => {
    const period = currentPeriodStart()
    await seedUsage('user:3', period, TIERS.free.interactionsPerMonth)
    await expect(
      chargeInteractions({ attributedTo: 'user:3', plan: 'free', delta: 1, periodStart: period })
    ).rejects.toThrow(BudgetExhausted)
    // Retry should ALSO throw — first throw didn't silently consume the
    // counter. If the rollback were broken, the retry might see a
    // different state and behave non-deterministically.
    await expect(
      chargeInteractions({ attributedTo: 'user:3', plan: 'free', delta: 1, periodStart: period })
    ).rejects.toThrow(BudgetExhausted)
  })
})

describe('chargeInteractions — test-mode bypass', () => {
  beforeEach(async () => {
    await resetDb()
    vi.stubEnv('TEST_MODE', '1')
  })
  afterEach(() => { vi.unstubAllEnvs() })

  it('TEST_MODE=1 returns full cap without touching the DB', async () => {
    const result = await chargeInteractions({
      attributedTo: 'user:42', plan: 'ultra', delta: 100_000, periodStart: currentPeriodStart()
    })
    expect(result.remaining).toBe(TIERS.ultra.interactionsPerMonth)
    // No row inserted.
    const r = await testDb().query<{ c: string }>(
      `SELECT COUNT(*) AS c FROM ai_usage_period`
    )
    expect(Number(r.rows[0].c)).toBe(0)
  })

  it('TEST_MODE=1 even allows absurd deltas — charges are no-ops in tests', async () => {
    // Integration tests run with TEST_MODE=1 precisely so they don't
    // have to reason about quota on every AI call. Pin the bypass
    // behaviour: in test mode, budget is effectively infinite.
    const result = await chargeInteractions({
      attributedTo: 'user:42', plan: 'free', delta: 999_999, periodStart: currentPeriodStart()
    })
    expect(result.remaining).toBe(TIERS.free.interactionsPerMonth)
  })
})

describe('interactionsForAudioMs', () => {
  it('1 interaction per 12 seconds (5 per minute, per AGENTS.md §15)', () => {
    expect(interactionsForAudioMs(60_000)).toBe(5) // exactly 1 minute → 5
    expect(interactionsForAudioMs(12_000)).toBe(1) // exactly 12s → 1
  })
  it('rounds up (ceil) — partial 12s blocks bill as full', () => {
    expect(interactionsForAudioMs(1)).toBe(1) // any audio → at least 1
    expect(interactionsForAudioMs(11_999)).toBe(1)
    expect(interactionsForAudioMs(12_001)).toBe(2) // just past → 2
  })
  it('zero or negative → 0', () => {
    expect(interactionsForAudioMs(0)).toBe(0)
    expect(interactionsForAudioMs(-100)).toBe(0)
  })
  it('5 minutes → 25 interactions', () => {
    expect(interactionsForAudioMs(5 * 60_000)).toBe(25)
  })
})
