import { describe, it, expect } from 'vitest'
import {
  TIERS,
  PLAN_NAMES,
  MONOTONIC_CAP_FIELDS,
  LEGACY_KNOWLEDGE_SHIM,
  LEGACY_WORKSPACES_SHIM,
  type TierCaps
} from '../../shared/config/tiers'

// Subscription tier caps. These tests intentionally DO NOT restate the
// exact numbers from the config — that would just duplicate the source
// of truth. Instead they encode product invariants so that a wrong
// value fails by violating a relationship (e.g. "Pro gave less than
// Free for bytes"), not by diverging from a hardcoded twin the test
// file also has to maintain.
//
// The shim-vs-max tests verify the phase-1 compatibility shim isn't
// stricter than the Max tier (which would regress every existing
// Max-level user before any tier code even ships). Those tests die in
// the same PR that removes the shims (phase 3/4).

describe('tier config — completeness', () => {
  it('every plan name has a tier object', () => {
    for (const plan of PLAN_NAMES) {
      expect(TIERS[plan], `missing tier object for "${plan}"`).toBeDefined()
    }
  })

  it('every tier has every cap field populated with a positive finite number', () => {
    const requiredFields: (keyof TierCaps)[] = [
      'interactionsPerMonth',
      'workspacesOwned',
      'knowledgeFiles',
      'knowledgeBytesPerWorkspace',
      'knowledgeBytesPerUser',
      'dictationMsPerDay'
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

describe('tier config — monotonicity (paid tiers must grant strictly more)', () => {
  // The "more is better" fields. knowledgeBytesPerWorkspace is
  // intentionally NOT in this list — the per-workspace cap is about
  // single-corpus size, not per-user total. A Max/Ultra user can have
  // MORE workspaces each at 1 GB rather than one giant workspace;
  // that's a product decision, not an accidental regression.
  for (const field of MONOTONIC_CAP_FIELDS) {
    it(`${field}: free < pro <= max <= ultra`, () => {
      const free = TIERS.free[field]
      const pro = TIERS.pro[field]
      const max = TIERS.max[field]
      const ultra = TIERS.ultra[field]

      // Free must be strictly less than Pro — otherwise Pro isn't a
      // meaningful upgrade on this dimension. (Strict, not >=, to
      // prevent a "both at 100" oversight.)
      expect(pro, `pro.${field} must exceed free.${field} — upgrade gives more`).toBeGreaterThan(free)
      // Max and Ultra are allowed to tie on some fields (e.g. dictation
      // is already generous at Max). Just never decrease.
      expect(max, `max.${field} must be >= pro.${field}`).toBeGreaterThanOrEqual(pro)
      expect(ultra, `ultra.${field} must be >= max.${field}`).toBeGreaterThanOrEqual(max)
    })
  }
})

describe('tier config — Free must be usable AND bounded', () => {
  it('free gives non-zero interactions', () => {
    // A zero-interaction Free tier is a product that tells
    // anonymous/trial users "no AI for you" on first click. That's
    // the anti-funnel; never ship it.
    expect(TIERS.free.interactionsPerMonth).toBeGreaterThan(0)
  })

  it('free does not cannibalise Pro', () => {
    // Free must leave enough headroom that Pro is worth paying for.
    // Concretely: Pro's interaction budget should be at least 5x
    // Free's. If we ever find the gap shrinking, that's a sign Free
    // crept up or Pro crept down without re-checking the other.
    expect(TIERS.pro.interactionsPerMonth).toBeGreaterThanOrEqual(TIERS.free.interactionsPerMonth * 5)
  })
})

describe('tier config — legacy shims (delete with phase 3/4)', () => {
  // These tests verify that the compatibility shims in nuxt.config.ts
  // aren't silently stricter than the Max tier — otherwise existing
  // Max-level users would see a regression at phase-1 boot, BEFORE any
  // tier-aware enforcement ever ships. The shim values are the single
  // cap every user sees during phase 1, so they must be at least as
  // generous as the most-generous tier that reads them.
  //
  // Phase 3/4 removes the shims; these tests die at the same time.

  it('knowledge shim is at least as permissive as the Max tier for workspace-scoped caps', () => {
    expect(LEGACY_KNOWLEDGE_SHIM.maxFilesPerWorkspace).toBeGreaterThanOrEqual(TIERS.max.knowledgeFiles)
    expect(LEGACY_KNOWLEDGE_SHIM.maxTotalBytesPerWorkspace).toBeGreaterThanOrEqual(TIERS.max.knowledgeBytesPerWorkspace)
  })

  it('knowledge shim is at least as permissive as the Pro tier for per-user caps', () => {
    // The per-user shim is intentionally lower than what Max/Ultra
    // grant (2 GB vs 10 GB / 50 GB) — phase-0 only ever offered one
    // flat cap, and the Pro numbers match what phase-0 users already
    // had. Floor the shim at Pro so no phase-0 user sees a regression;
    // Max/Ultra users only get their full cap after phase 3/4.
    expect(LEGACY_KNOWLEDGE_SHIM.maxFilesPerUser).toBeGreaterThanOrEqual(TIERS.pro.knowledgeFiles)
    expect(LEGACY_KNOWLEDGE_SHIM.maxTotalBytesPerUser).toBeGreaterThanOrEqual(TIERS.pro.knowledgeBytesPerUser)
  })

  it('workspaces.maxPerUser shim does not undercut the Free tier', () => {
    // Known-tight relationship: shim=20, ultra=100. That's fine
    // during phase 1 because nobody has a paid plan yet — everyone's
    // effective cap is the shim. But if the shim ever drops below the
    // Free tier, even Free users would regress. Pin the floor.
    expect(LEGACY_WORKSPACES_SHIM.maxPerUser).toBeGreaterThanOrEqual(TIERS.free.workspacesOwned)
  })
})
