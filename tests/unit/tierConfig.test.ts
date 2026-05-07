import { describe, it, expect } from 'vitest'
import {
  TIERS,
  PLAN_NAMES,
  MONOTONIC_CAP_FIELDS,
  KNOWLEDGE_PLATFORM_LIMITS,
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
      expect(TIERS[plan], `missing tier object for "${plan}"`).toBeDefined()
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
      const caps = TIERS[plan]
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
      const free = TIERS.free[field]
      const pro = TIERS.pro[field]
      const max = TIERS.max[field]
      const ultra = TIERS.ultra[field]
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
    expect(TIERS.free.litellmBudgetUsd).toBeGreaterThan(0)
  })

  it('free does not cannibalise Pro', () => {
    // Pro must be a meaningful upgrade. Floor at 5x Free budget
    // so neither can creep toward the other unnoticed.
    expect(TIERS.pro.litellmBudgetUsd).toBeGreaterThanOrEqual(TIERS.free.litellmBudgetUsd * 5)
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
