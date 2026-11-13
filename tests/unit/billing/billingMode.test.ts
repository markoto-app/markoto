import { describe, it, expect, vi, afterEach } from 'vitest'
import { resolveBillingMode } from '../../../shared/config/billingMode'

// `createError` is a Nitro auto-import in the SUT; stub it with an
// object carrying the same fields so assertions can read them.
vi.stubGlobal('createError', (opts: { statusCode: number, message: string, data?: unknown }) => {
  return Object.assign(new Error(opts.message), { statusCode: opts.statusCode, data: opts.data })
})

const {
  assertBillingEnabled,
  budgetExhaustedMessage,
  budgetExhaustedMessageKey,
  effectivePlan,
  isBillingEnabled,
  limitRecovery,
  limitUpgradeHint
} = await import('../../../server/utils/billing/billingMode')

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('resolveBillingMode', () => {
  it('defaults to billing off, no coming-soon surfaces (self-hosted default)', () => {
    expect(resolveBillingMode({})).toEqual({ billingEnabled: false, plansComingSoon: false })
  })

  it('billing off + NUXT_PLANS_COMING_SOON → hosted free-only SaaS', () => {
    expect(resolveBillingMode({ NUXT_PLANS_COMING_SOON: 'true' }))
      .toEqual({ billingEnabled: false, plansComingSoon: true })
  })

  it('billing on ignores NUXT_PLANS_COMING_SOON (nothing is "coming" once it is live)', () => {
    expect(resolveBillingMode({ NUXT_BILLING_ENABLED: 'true', NUXT_PLANS_COMING_SOON: 'true' }))
      .toEqual({ billingEnabled: true, plansComingSoon: false })
  })
})

describe('server billing-mode helpers', () => {
  it('assertBillingEnabled throws 404 billing/disabled when off, and passes when on', () => {
    vi.stubEnv('NUXT_BILLING_ENABLED', '')
    expect(isBillingEnabled()).toBe(false)
    expect(() => assertBillingEnabled()).toThrow(expect.objectContaining({
      statusCode: 404,
      data: { code: 'billing/disabled' }
    }))

    vi.stubEnv('NUXT_BILLING_ENABLED', 'true')
    expect(isBillingEnabled()).toBe(true)
    expect(() => assertBillingEnabled()).not.toThrow()
  })

  it('effectivePlan: billing off forces free even for a stored paid plan', () => {
    vi.stubEnv('NUXT_BILLING_ENABLED', 'false')
    const future = new Date(Date.now() + 86_400_000)
    expect(effectivePlan('pro', future)).toBe('free')
    expect(effectivePlan('pro', null)).toBe('free')
  })

  it('effectivePlan: billing on keeps an active paid plan and lapses an expired one', () => {
    vi.stubEnv('NUXT_BILLING_ENABLED', 'true')
    const now = new Date('2026-10-26T12:00:00Z')
    expect(effectivePlan('pro', new Date('2026-11-01T00:00:00Z'), now)).toBe('pro')
    expect(effectivePlan('pro', new Date('2026-10-01T00:00:00Z'), now)).toBe('free')
    expect(effectivePlan('free', null, now)).toBe('free')
  })

  it('limit hints never point at a purchase that does not exist', () => {
    vi.stubEnv('NUXT_BILLING_ENABLED', 'false')
    vi.stubEnv('NUXT_PLANS_COMING_SOON', 'false')
    expect(limitRecovery()).toBeUndefined()
    expect(limitUpgradeHint()).not.toMatch(/upgrade|pricing/i)
    expect(budgetExhaustedMessage()).not.toMatch(/upgrade|pricing/i)
    expect(budgetExhaustedMessageKey()).toBe('ai.budgetExhaustedResetDescription')

    vi.stubEnv('NUXT_PLANS_COMING_SOON', 'true')
    expect(limitRecovery()).toEqual({ kind: 'link', href: '/pricing', labelKey: 'billing.comingSoonCta' })
    expect(limitUpgradeHint()).toMatch(/coming soon/i)
    expect(budgetExhaustedMessage()).toMatch(/coming soon/i)
    expect(budgetExhaustedMessage()).not.toMatch(/upgrade/i)
    expect(budgetExhaustedMessageKey()).toBe('ai.budgetExhaustedComingSoonDescription')

    vi.stubEnv('NUXT_BILLING_ENABLED', 'true')
    expect(limitRecovery()).toEqual({ kind: 'link', href: '/pricing', labelKey: 'ai.upgradeCta' })
    expect(limitUpgradeHint()).toMatch(/pricing/)
    expect(budgetExhaustedMessageKey()).toBe('ai.budgetExhaustedDescription')
  })
})
