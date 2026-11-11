import { describe, it, expect, vi } from 'vitest'
import { DEFAULT_TIERS } from '../../../shared/config/tiers'

vi.stubGlobal('createError', (input: { statusCode: number, message: string, data?: unknown }) => Object.assign(new Error(input.message), input))
vi.mock('../../../server/utils/billing/tierConfig', () => ({ getTiers: () => DEFAULT_TIERS }))
vi.mock('../../../server/repos/workspaceSubscriptions', async orig => ({ ...(await orig()), getWorkspaceSubscription: vi.fn() }))
vi.mock('../../../server/repos/workspaceMembers', () => ({ countMembers: vi.fn() }))
vi.mock('../../../server/repos/workspaceInvites', () => ({ countOpenWorkspaceInvites: vi.fn() }))

const {
  budgetSeats,
  changedSeatBudgetAdjust,
  memberLimitUsd,
  parseSeats,
  pooledFromRow,
  workspacePoolCaps,
  MIN_WORKSPACE_SEATS
} = await import('../../../server/utils/billing/workspaceBilling')
const { isWorkspaceTeamBudgetError, workspaceTeamId } = await import('../../../server/utils/litellm/workspaceTeams')

const GB = 1024 * 1024 * 1024

describe('workspacePoolCaps', () => {
  it('multiplies the per-seat Team values by the seats', () => {
    const caps = workspacePoolCaps('team', 4, DEFAULT_TIERS)
    expect(caps.aiBudgetUsd).toBe(DEFAULT_TIERS.team.litellmBudgetUsd * 4)
    expect(caps.defaultMemberLimitUsd).toBe(DEFAULT_TIERS.team.litellmBudgetUsd * 2)
    expect(caps.knowledgeBytes).toBe(5 * GB * 4)
    expect(caps.imageBytes).toBe(10 * GB * 4)
    expect(caps.knowledgeFiles).toBe(DEFAULT_TIERS.team.knowledgeFiles * 4)
  })

  it('treats a zero / negative seat count as one seat', () => {
    expect(workspacePoolCaps('business', 0, DEFAULT_TIERS).aiBudgetUsd).toBe(DEFAULT_TIERS.business.litellmBudgetUsd)
  })
})

describe('memberLimitUsd', () => {
  const caps = workspacePoolCaps('team', 3, DEFAULT_TIERS)
  it('default, explicit and unlimited', () => {
    expect(memberLimitUsd({ aiLimitUsd: null, aiUnlimited: false }, caps)).toBe(caps.defaultMemberLimitUsd)
    expect(memberLimitUsd({ aiLimitUsd: 2.5, aiUnlimited: false }, caps)).toBe(2.5)
    expect(memberLimitUsd({ aiLimitUsd: 0, aiUnlimited: false }, caps)).toBe(0)
    expect(memberLimitUsd({ aiLimitUsd: 2.5, aiUnlimited: true }, caps)).toBeNull()
  })
})

describe('parseSeats', () => {
  it('accepts whole numbers from the minimum up', () => {
    expect(parseSeats(MIN_WORKSPACE_SEATS)).toBe(MIN_WORKSPACE_SEATS)
    expect(parseSeats('12')).toBe(12)
  })
  it.each([2, 0, -3, 3.5, 'x', null, undefined, 100000])('rejects %s', (value) => {
    expect(() => parseSeats(value)).toThrow(/Seats must be/)
  })
})

describe('pooledFromRow', () => {
  const base = {
    workspaceId: 'ws1', plan: 'team' as const, seats: 5, billingAdminId: 1, stripeCustomerId: 'cus', stripeSubscriptionId: 'sub',
    currentPeriodStart: null, litellmTeamId: null, budgetSeatAdjust: 0, budgetSeatAdjustUntil: null, currency: 'eur' as const, interval: 'month' as const, createdAt: new Date(), updatedAt: new Date()
  }
  const now = new Date('2027-01-01T00:00:00Z')
  it('pools active, trialing and past_due subscriptions that haven\'t expired', () => {
    for (const status of ['active', 'trialing', 'past_due']) {
      expect(pooledFromRow({ ...base, status, validUntil: new Date('2027-02-01') }, now)?.seats, status).toBe(5)
    }
  })
  it('does not pool incomplete, cancelled or expired subscriptions', () => {
    expect(pooledFromRow({ ...base, status: 'incomplete', validUntil: null }, now)).toBeNull()
    expect(pooledFromRow({ ...base, status: 'canceled', validUntil: new Date('2027-02-01') }, now)).toBeNull()
    expect(pooledFromRow({ ...base, status: 'active', validUntil: new Date('2026-12-01') }, now)).toBeNull()
  })
})

describe('workspace team budget errors', () => {
  it('tells the team budget apart from a key budget and from the free pool', () => {
    const team = new Error(`Budget has been exceeded! Team=${workspaceTeamId('ws1')} Current cost: 20.1, Max budget: 20`)
    const key = new Error('Budget has been exceeded! Current cost: 3, Max budget: 2.5')
    const free = new Error('Budget has been exceeded! Team=markoto-free-tier Current cost: 501, Max budget: 500')
    expect(isWorkspaceTeamBudgetError(team)).toBe(true)
    expect(isWorkspaceTeamBudgetError(key)).toBe(false)
    expect(isWorkspaceTeamBudgetError(free)).toBe(false)
    expect(isWorkspaceTeamBudgetError(null)).toBe(false)
  })
})

describe('seat changes and the pooled AI budget', () => {
  const now = new Date('2027-03-10T00:00:00Z')
  const days = (n: number) => new Date(now.getTime() + n * 24 * 60 * 60 * 1000)
  const none = { budgetSeatAdjust: 0, budgetSeatAdjustUntil: null }

  it('added seats unlock budget only for the days left in the window', () => {
    // 3 of 30 days left: each added seat is worth a tenth of a seat's budget.
    const r = changedSeatBudgetAdjust({ current: none, from: 3, to: 1003, windowEnd: days(3), now })
    expect(r.until).toEqual(days(3))
    expect(budgetSeats({ seats: 1003, budgetSeatAdjust: r.adjust, budgetSeatAdjustUntil: r.until }, now)).toBeCloseTo(103)
  })

  it('a seat added at the start of a window unlocks its full budget', () => {
    const r = changedSeatBudgetAdjust({ current: none, from: 3, to: 4, windowEnd: days(30), now })
    expect(budgetSeats({ seats: 4, budgetSeatAdjust: r.adjust, budgetSeatAdjustUntil: r.until }, now)).toBe(4)
  })

  it('removed seats keep their budget until the window ends', () => {
    const r = changedSeatBudgetAdjust({ current: none, from: 10, to: 4, windowEnd: days(12), now })
    const row = { seats: 4, budgetSeatAdjust: r.adjust, budgetSeatAdjustUntil: r.until }
    expect(budgetSeats(row, now)).toBe(10)
    expect(budgetSeats(row, days(12))).toBe(4)
  })

  it('add-then-remove in one window never yields more budget than was paid for', () => {
    const add = changedSeatBudgetAdjust({ current: none, from: 3, to: 1003, windowEnd: days(3), now })
    const remove = changedSeatBudgetAdjust({
      current: { budgetSeatAdjust: add.adjust, budgetSeatAdjustUntil: add.until }, from: 1003, to: 3, windowEnd: days(3), now
    })
    expect(budgetSeats({ seats: 3, budgetSeatAdjust: remove.adjust, budgetSeatAdjustUntil: remove.until }, now)).toBeCloseTo(103)
  })

  it('an adjustment from an ended window is dropped; no window means no adjustment', () => {
    const stale = { budgetSeatAdjust: 50, budgetSeatAdjustUntil: days(-1) }
    expect(budgetSeats({ seats: 5, ...stale }, now)).toBe(5)
    expect(changedSeatBudgetAdjust({ current: stale, from: 5, to: 6, windowEnd: days(15), now }).adjust).toBeCloseTo(-0.5)
    expect(changedSeatBudgetAdjust({ current: none, from: 5, to: 6, windowEnd: null, now })).toEqual({ adjust: 0, until: null })
  })
})
