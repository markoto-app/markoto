import { describe, it, expect } from 'vitest'
import {
  currentPeriodStart,
  effectivePeriodStart,
  effectivePeriodEnd
} from '../../server/utils/billing'

// Small pure-function test for the period-start helper. The function
// is simple but load-bearing: it picks the row key in
// `ai_usage_period`, so a boundary bug (e.g. returning last month on
// the 1st at 00:00:01 UTC) would silently charge this month's AI
// activity against last month's counter.

describe('currentPeriodStart', () => {
  it('returns the first of the current UTC month at 00:00:00.000', () => {
    const mid = currentPeriodStart(new Date('2026-04-15T13:45:12.321Z'))
    expect(mid.toISOString()).toBe('2026-04-01T00:00:00.000Z')
  })

  it('on the 1st at 00:00:00, returns the same instant (idempotent at boundary)', () => {
    // "Is Jan 1 considered last month or this month?" — we want it to
    // round DOWN to itself, not up to Feb or down to Dec.
    const start = currentPeriodStart(new Date('2026-04-01T00:00:00.000Z'))
    expect(start.toISOString()).toBe('2026-04-01T00:00:00.000Z')
  })

  it('last-ms of the month belongs to the current month, not next', () => {
    // 23:59:59.999 on April 30 must still resolve to April 1, not
    // prematurely roll over to May. If the helper used the local
    // timezone of the server (which can be ahead of UTC), a UTC-late
    // call could return May here.
    const end = currentPeriodStart(new Date('2026-04-30T23:59:59.999Z'))
    expect(end.toISOString()).toBe('2026-04-01T00:00:00.000Z')
  })

  it('January rollover: Jan 1 00:00:00 UTC does NOT resolve to December', () => {
    const jan = currentPeriodStart(new Date('2026-01-01T00:00:00.000Z'))
    expect(jan.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })

  it('uses UTC, not local time', () => {
    // 2026-04-01T00:30:00 in Asia/Tokyo (+09:00) is 2026-03-31T15:30Z.
    // A naive local-time impl would return April 1; UTC impl returns
    // March 1. This test pins the UTC behaviour.
    const d = new Date('2026-03-31T15:30:00.000Z')
    expect(currentPeriodStart(d).toISOString()).toBe('2026-03-01T00:00:00.000Z')
  })

  it('defaults to now() when called with no arg', () => {
    // Just verify it returns a valid Date on the 1st of SOME month.
    // We don't pin the specific month (that would rot daily).
    const r = currentPeriodStart()
    expect(r.getUTCDate()).toBe(1)
    expect(r.getUTCHours()).toBe(0)
    expect(r.getUTCMinutes()).toBe(0)
    expect(r.getUTCSeconds()).toBe(0)
    expect(r.getUTCMilliseconds()).toBe(0)
  })
})

// effectivePeriodStart — the Model C resolver. Picks Stripe anniversary
// for active paid users and calendar-month for everyone else (free,
// lapsed, or paid without a Stripe anchor yet).

describe('effectivePeriodStart', () => {
  const now = new Date('2026-04-20T10:00:00.000Z')

  it('free → calendar-month first', () => {
    const r = effectivePeriodStart({
      plan: 'free', stripeCurrentPeriodStart: null, planValidUntil: null, now
    })
    expect(r.toISOString()).toBe('2026-04-01T00:00:00.000Z')
  })

  it('paid + active + stripe anchor set → Stripe anniversary', () => {
    // A Pro user subscribed on the 15th; current period runs Apr 15 → May 15.
    const stripeStart = new Date('2026-04-15T00:00:00.000Z')
    const stripeEnd = new Date('2026-05-15T00:00:00.000Z')
    const r = effectivePeriodStart({
      plan: 'pro',
      stripeCurrentPeriodStart: stripeStart,
      planValidUntil: stripeEnd,
      now
    })
    expect(r.toISOString()).toBe('2026-04-15T00:00:00.000Z')
  })

  it('paid + active + NO stripe anchor → calendar fallback', () => {
    // Test fixtures / admin-promoted users without a Stripe sub. We'd
    // rather give them SOME anchor (calendar) than crash.
    const r = effectivePeriodStart({
      plan: 'max',
      stripeCurrentPeriodStart: null,
      planValidUntil: new Date('2026-05-30T00:00:00.000Z'),
      now
    })
    expect(r.toISOString()).toBe('2026-04-01T00:00:00.000Z')
  })

  it('paid but LAPSED → calendar fallback (defensive downgrade)', () => {
    // User's subscription expired; should behave like Free. Even if
    // Stripe anchor is still set (webhook hasn't run yet), we use
    // calendar month so the resolver's `callerActive=false` path
    // stays consistent with its period choice.
    const r = effectivePeriodStart({
      plan: 'pro',
      stripeCurrentPeriodStart: new Date('2026-03-15T00:00:00.000Z'),
      planValidUntil: new Date('2026-04-15T00:00:00.000Z'), // in the past relative to `now`
      now
    })
    expect(r.toISOString()).toBe('2026-04-01T00:00:00.000Z')
  })

  it('paid + active + planValidUntil null (e.g. lifetime grant) → Stripe anchor wins', () => {
    // Edge case used by some test fixtures: paid plan with
    // planValidUntil intentionally null to signal "never lapses".
    // Must still respect the stripe anchor — we're NOT in the lapsed
    // branch because null ≠ past timestamp.
    const stripeStart = new Date('2026-04-10T00:00:00.000Z')
    const r = effectivePeriodStart({
      plan: 'ultra',
      stripeCurrentPeriodStart: stripeStart,
      planValidUntil: null,
      now
    })
    expect(r.toISOString()).toBe('2026-04-10T00:00:00.000Z')
  })
})

describe('effectivePeriodEnd', () => {
  const now = new Date('2026-04-20T10:00:00.000Z')

  it('free → first of next calendar month', () => {
    const r = effectivePeriodEnd({
      plan: 'free', stripeCurrentPeriodStart: null, planValidUntil: null, now
    })
    expect(r.toISOString()).toBe('2026-05-01T00:00:00.000Z')
  })

  it('paid + active + stripe anchor → planValidUntil (= current_period_end)', () => {
    const r = effectivePeriodEnd({
      plan: 'pro',
      stripeCurrentPeriodStart: new Date('2026-04-15T00:00:00.000Z'),
      planValidUntil: new Date('2026-05-15T00:00:00.000Z'),
      now
    })
    expect(r.toISOString()).toBe('2026-05-15T00:00:00.000Z')
  })

  it('lapsed paid → first of next calendar month (matches start-side fallback)', () => {
    // Periods must have start + end agree on which anchor to use;
    // otherwise the "Resets on {periodEnd}" copy would be inconsistent
    // with the counter's actual period row.
    const r = effectivePeriodEnd({
      plan: 'pro',
      stripeCurrentPeriodStart: new Date('2026-03-15T00:00:00.000Z'),
      planValidUntil: new Date('2026-04-15T00:00:00.000Z'),
      now
    })
    expect(r.toISOString()).toBe('2026-05-01T00:00:00.000Z')
  })

  it('paid without stripe anchor → calendar fallback (matches start)', () => {
    const r = effectivePeriodEnd({
      plan: 'max',
      stripeCurrentPeriodStart: null,
      planValidUntil: new Date('2026-05-30T00:00:00.000Z'),
      now
    })
    expect(r.toISOString()).toBe('2026-05-01T00:00:00.000Z')
  })

  it('January rollover from December', () => {
    const dec = new Date('2026-12-20T10:00:00.000Z')
    const r = effectivePeriodEnd({
      plan: 'free', stripeCurrentPeriodStart: null, planValidUntil: null, now: dec
    })
    expect(r.toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })
})

