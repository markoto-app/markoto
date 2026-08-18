import { describe, it, expect } from 'vitest'
import {
  DEFAULT_TIERS,
  PLAN_NAMES,
  MONOTONIC_CAP_FIELDS,
  KNOWLEDGE_PLATFORM_LIMITS,
  resolveTiersFromEnv,
  type TierCaps
} from '../../shared/config/tiers'

// Subscription tier caps. These tests intentionally DO NOT restate the
// exact numbers from the config — that would just duplicate the source
// of truth. Instead they encode product invariants so that a wrong
// value fails by violating a relationship (e.g. "Pro gave less than
// Free for bytes"), not by diverging from a hardcoded twin the test
// file also has to maintain.

describe('tier config — completeness', () => {
  it('every plan name has a tier object', () => {
    for (const plan of PLAN_NAMES) {
      expect(DEFAULT_TIERS[plan], `missing tier object for "${plan}"`).toBeDefined()
    }
  })

  it('every tier has every cap field populated with a positive finite number', () => {
    const requiredFields: (keyof TierCaps)[] = [
      'litellmBudgetUsd',
      'workspacesOwned',
      'knowledgeFiles',
      'knowledgeBytesPerWorkspace',
      'knowledgeBytesPerUser'
    ]
    for (const plan of PLAN_NAMES) {
      const caps = DEFAULT_TIERS[plan]
      for (const field of requiredFields) {
        const v = caps[field]
        expect(typeof v, `${plan}.${field} wrong type`).toBe('number')
        expect(Number.isFinite(v), `${plan}.${field} must be finite`).toBe(true)
        expect(v, `${plan}.${field} must be > 0 — zero is a disabled product, almost always a typo`).toBeGreaterThan(0)
      }
    }
  })
})

describe('tier config — monotonicity (paid tiers grant strictly more)', () => {
  // `knowledgeBytesPerWorkspace` is intentionally NOT in this list —
  // the per-workspace cap is about one-workspace corpus size, not
  // per-user total. A Max/Ultra user gets more total via the per-user
  // cap, spread across more workspaces.
  for (const field of MONOTONIC_CAP_FIELDS) {
    it(`${field}: free < pro <= max <= ultra`, () => {
      const free = DEFAULT_TIERS.free[field]
      const pro = DEFAULT_TIERS.pro[field]
      const max = DEFAULT_TIERS.max[field]
      const ultra = DEFAULT_TIERS.ultra[field]
      expect(pro, `pro.${field} must exceed free.${field} — upgrade gives more`).toBeGreaterThan(free)
      expect(max, `max.${field} must be >= pro.${field}`).toBeGreaterThanOrEqual(pro)
      expect(ultra, `ultra.${field} must be >= max.${field}`).toBeGreaterThanOrEqual(max)
    })
  }
})

describe('tier config — Free must be usable AND bounded', () => {
  it('free gives non-zero AI Points budget', () => {
    // A zero-budget Free tier shows "no AI for you" on first click —
    // anti-funnel, never ship it.
    expect(DEFAULT_TIERS.free.litellmBudgetUsd).toBeGreaterThan(0)
  })

  it('free does not cannibalise Pro', () => {
    // Pro must be a meaningful upgrade. Floor at 5x Free budget
    // so neither can creep toward the other unnoticed.
    expect(DEFAULT_TIERS.pro.litellmBudgetUsd).toBeGreaterThanOrEqual(DEFAULT_TIERS.free.litellmBudgetUsd * 5)
  })
})

describe('KNOWLEDGE_PLATFORM_LIMITS — non-tier constants', () => {
  it('every field is a positive finite number', () => {
    for (const [key, value] of Object.entries(KNOWLEDGE_PLATFORM_LIMITS)) {
      expect(typeof value, `${key} wrong type`).toBe('number')
      expect(Number.isFinite(value), `${key} must be finite`).toBe(true)
      expect(value, `${key} must be > 0`).toBeGreaterThan(0)
    }
  })
})

describe('resolveTiersFromEnv — runtime overrides', () => {
  it('returns the committed defaults when no override vars are present', () => {
    expect(resolveTiersFromEnv({})).toEqual(DEFAULT_TIERS)
  })

  it('overrides a single field and leaves everything else at default', () => {
    const tiers = resolveTiersFromEnv({ TIER_PRO_LITELLM_BUDGET_USD: '8' })
    expect(tiers.pro.litellmBudgetUsd).toBe(8)
    expect(tiers.pro.workspacesOwned).toBe(DEFAULT_TIERS.pro.workspacesOwned)
    expect(tiers.free).toEqual(DEFAULT_TIERS.free)
    expect(tiers.max).toEqual(DEFAULT_TIERS.max)
    expect(tiers.ultra).toEqual(DEFAULT_TIERS.ultra)
  })

  it('supports every plan × field combination', () => {
    const tiers = resolveTiersFromEnv({
      TIER_FREE_LITELLM_BUDGET_USD: '2',
      TIER_PRO_WORKSPACES_OWNED: '25',
      TIER_MAX_KNOWLEDGE_FILES: '999',
      TIER_ULTRA_KNOWLEDGE_BYTES_PER_WORKSPACE: '123456789',
      TIER_ULTRA_KNOWLEDGE_BYTES_PER_USER: '987654321'
    })
    expect(tiers.free.litellmBudgetUsd).toBe(2)
    expect(tiers.pro.workspacesOwned).toBe(25)
    expect(tiers.max.knowledgeFiles).toBe(999)
    expect(tiers.ultra.knowledgeBytesPerWorkspace).toBe(123456789)
    expect(tiers.ultra.knowledgeBytesPerUser).toBe(987654321)
  })

  it('rejects invalid values — typos degrade to the default, never to a broken product', () => {
    const tiers = resolveTiersFromEnv({
      TIER_FREE_LITELLM_BUDGET_USD: 'not-a-number',
      TIER_PRO_LITELLM_BUDGET_USD: '0', // zero = disabled product, refused
      TIER_MAX_LITELLM_BUDGET_USD: '-5',
      TIER_ULTRA_LITELLM_BUDGET_USD: '', // empty string = unset
      TIER_ULTRA_KNOWLEDGE_FILES: 'Infinity'
    })
    expect(tiers).toEqual(DEFAULT_TIERS)
  })

  it('does not mutate DEFAULT_TIERS', () => {
    const before = JSON.parse(JSON.stringify(DEFAULT_TIERS))
    const tiers = resolveTiersFromEnv({ TIER_FREE_KNOWLEDGE_FILES: '42' })
    expect(tiers.free.knowledgeFiles).toBe(42)
    expect(DEFAULT_TIERS).toEqual(before)
  })
})
