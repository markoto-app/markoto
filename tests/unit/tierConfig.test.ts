import { describe, it, expect } from 'vitest'
import {
  DEFAULT_TIERS,
  PLAN_NAMES,
  MONOTONIC_CAP_FIELDS,
  KNOWLEDGE_PLATFORM_LIMITS,
  resolveTiersFromEnv,
  FEATURE_FIELDS,
  UNLIMITED_CAP_FIELDS,
  wouldExceed,
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
      'knowledgeBytesPerUser',
      'imageBytesPerUser'
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
  // per-user total.
  for (const field of MONOTONIC_CAP_FIELDS) {
    it(`${field}: free < pro <= team <= business`, () => {
      const free = DEFAULT_TIERS.free[field]
      const pro = DEFAULT_TIERS.pro[field]
      const team = DEFAULT_TIERS.team[field]
      const business = DEFAULT_TIERS.business[field]
      expect(pro, `pro.${field} must exceed free.${field} — upgrade gives more`).toBeGreaterThan(free)
      expect(team, `team.${field} must be >= pro.${field}`).toBeGreaterThanOrEqual(pro)
      expect(business, `business.${field} must be >= team.${field}`).toBeGreaterThanOrEqual(team)
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
    expect(tiers.team).toEqual(DEFAULT_TIERS.team)
    expect(tiers.business).toEqual(DEFAULT_TIERS.business)
  })

  it('supports every plan × field combination', () => {
    const tiers = resolveTiersFromEnv({
      TIER_FREE_LITELLM_BUDGET_USD: '2',
      TIER_PRO_WORKSPACES_OWNED: '25',
      TIER_TEAM_KNOWLEDGE_FILES: '999',
      TIER_BUSINESS_KNOWLEDGE_BYTES_PER_WORKSPACE: '123456789',
      TIER_BUSINESS_KNOWLEDGE_BYTES_PER_USER: '987654321',
      TIER_FREE_IMAGE_BYTES_PER_USER: '123456'
    })
    expect(tiers.free.litellmBudgetUsd).toBe(2)
    expect(tiers.pro.workspacesOwned).toBe(25)
    expect(tiers.team.knowledgeFiles).toBe(999)
    expect(tiers.business.knowledgeBytesPerWorkspace).toBe(123456789)
    expect(tiers.business.knowledgeBytesPerUser).toBe(987654321)
    expect(tiers.free.imageBytesPerUser).toBe(123456)
  })

  it('rejects invalid values — typos degrade to the default, never to a broken product', () => {
    const tiers = resolveTiersFromEnv({
      TIER_FREE_LITELLM_BUDGET_USD: 'not-a-number',
      TIER_PRO_LITELLM_BUDGET_USD: '0', // zero = disabled product, refused
      TIER_TEAM_LITELLM_BUDGET_USD: '-5',
      TIER_BUSINESS_LITELLM_BUDGET_USD: '', // empty string = unset
      TIER_BUSINESS_KNOWLEDGE_FILES: 'Infinity'
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

// ─── Phase A entitlements (plan limits + feature switches) ──────────────

describe('tier config — self-hosted instances keep every feature', () => {
  // Billing off (self-host) resolves everyone to `free`, so the COMMITTED
  // free tier is what a self-hoster gets: every feature switch on, no
  // member / history / MCP / web-tool limit. The hosted free tier is
  // narrowed only through TIER_FREE_* (infra/render-env.sh).
  it('switches every feature on in every committed tier', () => {
    for (const plan of PLAN_NAMES) {
      for (const feature of FEATURE_FIELDS) {
        expect(DEFAULT_TIERS[plan][feature], `${plan}.${feature}`).toBe(true)
      }
    }
  })

  it('sets no plan limit on the unlimited-capable fields of the committed free tier', () => {
    for (const field of UNLIMITED_CAP_FIELDS) {
      expect(DEFAULT_TIERS.free[field], `free.${field}`).toBeNull()
    }
  })

  it('keeps today\'s 20 saved themes and 50 MB imports on the committed free tier', () => {
    expect(DEFAULT_TIERS.free.savedThemes).toBe(20)
    expect(DEFAULT_TIERS.free.importMaxBytes).toBe(50 * 1024 * 1024)
  })
})

describe('tier config — paid tiers never give less than free', () => {
  const atLeast = (paid: number | null, free: number | null) =>
    paid === null || (free !== null && paid >= free)
  for (const field of [...UNLIMITED_CAP_FIELDS, 'savedThemes', 'importMaxBytes'] as const) {
    it(`${field}`, () => {
      for (const plan of PLAN_NAMES) {
        expect(atLeast(DEFAULT_TIERS[plan][field], DEFAULT_TIERS.free[field]), `${plan}.${field}`).toBe(true)
      }
    })
  }
})

describe('resolveTiersFromEnv — entitlement overrides', () => {
  it('parses numbers and `unlimited` for the unlimited-capable fields', () => {
    const tiers = resolveTiersFromEnv({
      TIER_FREE_MEMBERS_PER_WORKSPACE: '3',
      TIER_FREE_HISTORY_DAYS: '30',
      TIER_PRO_MEMBERS_PER_WORKSPACE: 'unlimited',
      TIER_FREE_WEB_TOOLS_PER_DAY: ' 20 ',
      TIER_FREE_MCP_TOOL_CALLS_PER_DAY: '100'
    })
    expect(tiers.free.membersPerWorkspace).toBe(3)
    expect(tiers.free.historyDays).toBe(30)
    expect(tiers.free.webToolsPerDay).toBe(20)
    expect(tiers.free.mcpToolCallsPerDay).toBe(100)
    expect(tiers.pro.membersPerWorkspace).toBeNull()
  })

  it('accepts `unlimited` only where the field allows it', () => {
    const tiers = resolveTiersFromEnv({ TIER_FREE_SAVED_THEMES: 'unlimited', TIER_FREE_WORKSPACES_OWNED: 'unlimited' })
    expect(tiers.free.savedThemes).toBe(DEFAULT_TIERS.free.savedThemes)
    expect(tiers.free.workspacesOwned).toBe(DEFAULT_TIERS.free.workspacesOwned)
  })

  it('parses feature switches (true/false/1/0/yes/no/on/off, any case)', () => {
    expect(resolveTiersFromEnv({ TIER_FREE_FEATURE_CUSTOM_CSS: 'false' }).free.customCss).toBe(false)
    expect(resolveTiersFromEnv({ TIER_FREE_FEATURE_CUSTOM_CSS: 'OFF' }).free.customCss).toBe(false)
    expect(resolveTiersFromEnv({ TIER_FREE_FEATURE_MCP_WRITE: '0' }).free.mcpWrite).toBe(false)
    expect(resolveTiersFromEnv({ TIER_FREE_FEATURE_MCP_WRITE: 'no' }).free.mcpWrite).toBe(false)
    expect(resolveTiersFromEnv({ TIER_FREE_FEATURE_CUSTOM_CSS: 'true' }).free.customCss).toBe(true)
  })

  it('keeps the default for an unparseable switch or number', () => {
    const tiers = resolveTiersFromEnv({
      TIER_FREE_FEATURE_CUSTOM_CSS: 'maybe',
      TIER_FREE_HISTORY_DAYS: '0',
      TIER_FREE_MEMBERS_PER_WORKSPACE: '-1',
      TIER_FREE_IMPORT_MAX_BYTES: 'big'
    })
    expect(tiers.free).toEqual(DEFAULT_TIERS.free)
  })
})

describe('wouldExceed', () => {
  it('treats null as no limit and a full limit as exceeded', () => {
    expect(wouldExceed(null, 10_000)).toBe(false)
    expect(wouldExceed(3, 2)).toBe(false)
    expect(wouldExceed(3, 3)).toBe(true)
  })
})
