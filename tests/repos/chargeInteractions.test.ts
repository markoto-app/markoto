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
  afterEach(() => {
    vi.unstubAllEnvs()
  })

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
  afterEach(() => {
    vi.unstubAllEnvs()
  })

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

// ─── Adversarial: rollback's `used` field reflects on-disk state ──────────

describe('chargeInteractions — BudgetExhausted.used reflects DISK state, not the would-be total', () => {
  beforeEach(async () => {
    await resetDb()
    vi.stubEnv('TEST_MODE', '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('after rollback, `used` is the pre-charge value (not pre-charge + delta)', async () => {
    // The UPDATE returns `interactions_used = X + delta` BEFORE we
    // compare to cap. If we naively used that value in the
    // BudgetExhausted message, the user would see "used 105/100" —
    // confusing and technically wrong, since the rollback means we
    // didn't actually spend those 5.
    //
    // The SUT re-reads the row's on-disk value after rollback. Verify
    // the BudgetExhausted's `used` field matches.
    const period = currentPeriodStart()
    const cap = TIERS.free.interactionsPerMonth
    await seedUsage('user:42', period, cap - 2) // 2 left

    let captured: BudgetExhausted | null = null
    try {
      await chargeInteractions({
        attributedTo: 'user:42', plan: 'free', delta: 5, periodStart: period
      })
    } catch (e) {
      captured = e as BudgetExhausted
    }

    expect(captured).toBeInstanceOf(BudgetExhausted)
    // On-disk used = cap - 2 (unchanged). NOT cap - 2 + 5 = cap + 3.
    expect(captured!.used).toBe(cap - 2)
    expect(captured!.cap).toBe(cap)
    expect(captured!.requestedDelta).toBe(5)

    // Belt + braces: the row's on-disk value is unchanged.
    const r = await testDb().query<{ used: number }>(
      `SELECT interactions_used AS used FROM ai_usage_period WHERE attributed_to = 'user:42'`
    )
    expect(r.rows[0].used).toBe(cap - 2)
  })

  it('rollback on a NON-existent row leaves no row behind (not even with the failed delta)', async () => {
    // First-ever charge that's already over cap → rollback. The
    // INSERT's row should NOT persist. If it did, the next call's
    // remaining-check would see a phantom usage that was never
    // actually authorised.
    const period = currentPeriodStart()
    const cap = TIERS.free.interactionsPerMonth

    await expect(
      chargeInteractions({
        attributedTo: 'user:fresh', plan: 'free', delta: cap + 1, periodStart: period
      })
    ).rejects.toThrow(BudgetExhausted)

    const r = await testDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ai_usage_period WHERE attributed_to = 'user:fresh'`
    )
    expect(Number(r.rows[0].n)).toBe(0)

    // And remaining still reads as full cap.
    const remaining = await getInteractionsRemaining('user:fresh', 'free', period)
    expect(remaining).toBe(cap)
  })
})

// ─── Adversarial: concurrency on the same period row ──────────────────────

describe('chargeInteractions — concurrent charges serialize via ON CONFLICT', () => {
  beforeEach(async () => {
    await resetDb()
    vi.stubEnv('TEST_MODE', '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('10 concurrent charges of +1 sum exactly to 10 (no lost updates)', async () => {
    // The atomic INSERT...ON CONFLICT DO UPDATE is what makes the
    // (+) workspace pool safe under multi-user concurrency. If row
    // locking ever broke (driver change, drizzle refactor, missing
    // PK), two parallel charges could both read the same prior value
    // and overwrite, losing one of the increments.
    const period = currentPeriodStart()

    await Promise.all(
      Array.from({ length: 10 }, () =>
        chargeInteractions({
          attributedTo: 'user:race', plan: 'pro', delta: 1, periodStart: period
        })
      )
    )

    const r = await testDb().query<{ used: number }>(
      `SELECT interactions_used AS used FROM ai_usage_period WHERE attributed_to = 'user:race'`
    )
    expect(r.rows[0].used).toBe(10)
  })

  it('concurrent charges that EXCEED cap together: cap is never breached, exactly one rollback per excess', async () => {
    // Cap=100, current used=99. Three concurrent +2 charges. Without
    // serialization: all three could see used=99, all UPDATE to 101,
    // all rollback. With serialization: the FIRST commits (sum=101 →
    // rollback); SECOND sees 99 still, commits sum=101 → rollback; etc.
    // Actually no: if the first rolls back, the row stays at 99, so
    // ALL three would rollback and we'd reject 3× the usage. Hmm.
    //
    // The honest invariant: concurrent over-cap charges all rollback
    // (correctly, because each individual charge would breach), and
    // the disk value never exceeds cap. Test that.
    const period = currentPeriodStart()
    const cap = TIERS.free.interactionsPerMonth
    await seedUsage('user:overrace', period, cap - 1) // 1 left

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        chargeInteractions({
          attributedTo: 'user:overrace', plan: 'free', delta: 2, periodStart: period
        })
      )
    )

    // All 5 should reject (each individual charge of +2 lands at
    // cap+1 → rollback).
    expect(results.every(r => r.status === 'rejected')).toBe(true)
    expect(results.every(r =>
      r.status === 'rejected' && r.reason instanceof BudgetExhausted
    )).toBe(true)

    // Disk value never exceeded cap; rollbacks held the line.
    const r = await testDb().query<{ used: number }>(
      `SELECT interactions_used AS used FROM ai_usage_period WHERE attributed_to = 'user:overrace'`
    )
    expect(r.rows[0].used).toBeLessThanOrEqual(cap)
    expect(r.rows[0].used).toBe(cap - 1) // Pinning: nothing committed.
  })

  it('mixed concurrent: some charges fit, others rollback — disk reflects only the fitting ones', async () => {
    // Cap=100, used=98. Seven concurrent +1 charges. The first 2
    // should commit (98 → 99 → 100), the last 5 should each see
    // used=100 and rollback (101 > cap). Final disk = 100.
    const period = currentPeriodStart()
    const cap = TIERS.free.interactionsPerMonth
    await seedUsage('user:mix', period, cap - 2)

    const results = await Promise.allSettled(
      Array.from({ length: 7 }, () =>
        chargeInteractions({
          attributedTo: 'user:mix', plan: 'free', delta: 1, periodStart: period
        })
      )
    )

    const ok = results.filter(r => r.status === 'fulfilled').length
    const rejected = results.filter(r => r.status === 'rejected').length
    expect(ok).toBe(2)
    expect(rejected).toBe(5)

    const r = await testDb().query<{ used: number }>(
      `SELECT interactions_used AS used FROM ai_usage_period WHERE attributed_to = 'user:mix'`
    )
    expect(r.rows[0].used).toBe(cap)
  })
})

describe('chargeInteractions — test-mode bypass', () => {
  beforeEach(async () => {
    await resetDb()
    vi.stubEnv('TEST_MODE', '1')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

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
