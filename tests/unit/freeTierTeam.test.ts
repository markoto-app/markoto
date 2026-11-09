import { describe, it, expect } from 'vitest'
import {
  FREE_TIER_TEAM_ID,
  freeTierTotalBudgetProblems,
  freeTierTotalBudgetUsd,
  isDuplicateTeamError,
  isFreeAllowanceExhaustedError,
  teamIdForPlan
} from '../../server/utils/litellm/freeTierTeam'
import { desiredKeyState, keyNeedsUpdate } from '../../server/utils/litellm/keyReconcile'

// The global monthly ceiling on platform-paid AI for free-tier users is a
// LiteLLM team budget. These pin the pure parts: config parsing, which
// keys belong to the pool, and telling a pool exhaustion apart from a
// per-user one (messages verbatim from LiteLLM v1.106.4).

describe('NUXT_FREE_TIER_TOTAL_BUDGET_USD', () => {
  it('a positive number is the ceiling', () => {
    expect(freeTierTotalBudgetUsd({ NUXT_FREE_TIER_TOTAL_BUDGET_USD: '500' })).toBe(500)
    expect(freeTierTotalBudgetUsd({ NUXT_FREE_TIER_TOTAL_BUDGET_USD: ' 12.5 ' })).toBe(12.5)
  })

  it('unset, empty, 0, negative or junk = no ceiling (self-host default)', () => {
    for (const raw of [undefined, '', '0', '-3', 'lots', 'Infinity']) {
      expect(freeTierTotalBudgetUsd({ NUXT_FREE_TIER_TOTAL_BUDGET_USD: raw }), String(raw)).toBeNull()
    }
  })

  it('reports junk at boot, but not the "off" spellings', () => {
    expect(freeTierTotalBudgetProblems({})).toEqual([])
    expect(freeTierTotalBudgetProblems({ NUXT_FREE_TIER_TOTAL_BUDGET_USD: '0' })).toEqual([])
    expect(freeTierTotalBudgetProblems({ NUXT_FREE_TIER_TOTAL_BUDGET_USD: 'lots' })).toHaveLength(1)
    expect(freeTierTotalBudgetProblems({ NUXT_FREE_TIER_TOTAL_BUDGET_USD: '-1' })).toHaveLength(1)
  })
})

describe('teamIdForPlan', () => {
  const on = { NUXT_FREE_TIER_TOTAL_BUDGET_USD: '500' }
  it('free keys join the pool while a ceiling is configured', () => {
    expect(teamIdForPlan('free', on)).toBe(FREE_TIER_TEAM_ID)
  })
  it('paid plans never do (they must not spend or be capped by the free pool)', () => {
    for (const plan of ['pro', 'team', 'business'] as const) expect(teamIdForPlan(plan, on)).toBeNull()
  })
  it('no ceiling → no team at all', () => {
    expect(teamIdForPlan('free', {})).toBeNull()
  })
})

describe('isFreeAllowanceExhaustedError', () => {
  it('matches the proxy\'s team-budget rejection', () => {
    expect(isFreeAllowanceExhaustedError(new Error('Error code: 422 - {"error":{"message":"Budget has been exceeded! Team=markoto-free-tier Current cost: 500.01, Max budget: 500.0","type":"budget_exceeded","param":null,"code":"422"}}'))).toBe(true)
    expect(isFreeAllowanceExhaustedError('Budget has been exceeded! Team=markoto-free-tier Current cost: 1, Max budget: 1')).toBe(true)
  })

  it('does not match a per-key exhaustion, another team or unrelated errors', () => {
    expect(isFreeAllowanceExhaustedError(new Error('Budget has been exceeded! Key=key (sk-...lt2Q) Current cost: 0.51, Max budget: 0.5'))).toBe(false)
    expect(isFreeAllowanceExhaustedError(new Error('Budget has been exceeded! Team=some-workspace-team Current cost: 2, Max budget: 1'))).toBe(false)
    expect(isFreeAllowanceExhaustedError(new Error('upstream 500'))).toBe(false)
    expect(isFreeAllowanceExhaustedError(null)).toBe(false)
  })
})

describe('isDuplicateTeamError', () => {
  it('both of LiteLLM\'s "team id taken" answers count as a lost create race', () => {
    expect(isDuplicateTeamError('{"error":{"message":"{\'error\': \'Team id = markoto-free-tier already exists. Please use a different team id.\'}","code":"400"}}')).toBe(true)
    expect(isDuplicateTeamError('{"error":{"message":"Unique constraint failed on the fields: (`team_id`)","type":"internal_server_error","code":"500"}}')).toBe(true)
    expect(isDuplicateTeamError('{"error":{"message":"Authentication Error","code":"401"}}')).toBe(false)
  })
})

describe('key reconciliation (pure)', () => {
  const hosted = { NUXT_FREE_TIER_TOTAL_BUDGET_USD: '500' }

  it('billing off: every account is free → pool + free budget + monthly reset', () => {
    const want = desiredKeyState('pro', null, hosted)
    expect(want.teamId).toBe(FREE_TIER_TEAM_ID)
    expect(want.budgetDuration).toBe('30d')
    expect(want.maxBudget).toBe(desiredKeyState('free', null, hosted).maxBudget)
  })

  it('a key that already matches needs no update (idempotent)', () => {
    const want = desiredKeyState('free', null, hosted)
    expect(keyNeedsUpdate({ team_id: want.teamId, max_budget: want.maxBudget, budget_duration: '30d' }, want)).toBe(false)
  })

  it('a key outside the pool, on an old budget or without the monthly reset is updated', () => {
    const want = desiredKeyState('free', null, hosted)
    expect(keyNeedsUpdate({ team_id: null, max_budget: want.maxBudget, budget_duration: '30d' }, want)).toBe(true)
    expect(keyNeedsUpdate({ team_id: want.teamId, max_budget: want.maxBudget + 0.5, budget_duration: '30d' }, want)).toBe(true)
    expect(keyNeedsUpdate({ team_id: want.teamId, max_budget: want.maxBudget, budget_duration: null }, want)).toBe(true)
  })

  it('removing the ceiling takes keys back out of the pool', () => {
    const want = desiredKeyState('free', null, {})
    expect(want.teamId).toBeNull()
    expect(keyNeedsUpdate({ team_id: FREE_TIER_TEAM_ID, max_budget: want.maxBudget, budget_duration: '30d' }, want)).toBe(true)
  })
})
