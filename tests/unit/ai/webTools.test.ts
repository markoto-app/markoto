import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Platform-paid web tools: per-user hourly/daily allowance shared by
// web_search + fetch_url, and availability from the operator's upstream keys.

const checkRateLimit = vi.hoisted(() => vi.fn(async (_ns: string, _key: string, _max: number, _windowMs: number) => true))
vi.mock('../../../server/utils/platform/rateLimit', () => ({ checkRateLimit }))
// The plan's daily web-tool limit (`webToolsPerDay`); null = no plan limit.
const planWebToolsPerDay = vi.hoisted(() => ({ value: null as number | null }))
vi.mock('../../../server/utils/billing/entitlements', () => ({
  resolveUserPlan: vi.fn(async () => 'free'),
  capsFor: vi.fn(() => ({ webToolsPerDay: planWebToolsPerDay.value }))
}))

const {
  consumeWebToolQuota,
  getWebToolLimits,
  getWebToolAvailability,
  isWebToolAvailable,
  WEB_TOOLS_RATE_LIMITED_CODE
} = await import('../../../server/utils/ai/webTools')

beforeEach(() => {
  planWebToolsPerDay.value = null
  checkRateLimit.mockClear()
  checkRateLimit.mockImplementation(async () => true)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('getWebToolLimits', () => {
  it('defaults to 30/hour and 100/day', () => {
    vi.stubEnv('NUXT_WEB_TOOLS_HOURLY_LIMIT', '')
    vi.stubEnv('NUXT_WEB_TOOLS_DAILY_LIMIT', '')
    expect(getWebToolLimits()).toEqual({ hourly: 30, daily: 100 })
  })

  it('honours overrides, 0 meaning unlimited', () => {
    vi.stubEnv('NUXT_WEB_TOOLS_HOURLY_LIMIT', '5')
    vi.stubEnv('NUXT_WEB_TOOLS_DAILY_LIMIT', '0')
    expect(getWebToolLimits()).toEqual({ hourly: 5, daily: 0 })
  })

  it('refuses garbage values (boot validation reports them first)', () => {
    vi.stubEnv('NUXT_WEB_TOOLS_HOURLY_LIMIT', 'lots')
    vi.stubEnv('NUXT_WEB_TOOLS_DAILY_LIMIT', '-3')
    expect(() => getWebToolLimits()).toThrow(/NUXT_WEB_TOOLS_HOURLY_LIMIT: expected an integer ≥ 0[\s\S]*NUXT_WEB_TOOLS_DAILY_LIMIT/)
  })

  it('a plan daily limit narrows the operator ceiling — the stricter wins', () => {
    vi.stubEnv('NUXT_WEB_TOOLS_HOURLY_LIMIT', '')
    vi.stubEnv('NUXT_WEB_TOOLS_DAILY_LIMIT', '100')
    expect(getWebToolLimits(20)).toEqual({ hourly: 30, daily: 20 })
    expect(getWebToolLimits(500)).toEqual({ hourly: 30, daily: 100 })
    expect(getWebToolLimits(null)).toEqual({ hourly: 30, daily: 100 })
  })

  it('an unlimited operator ceiling (0) leaves the plan limit in force', () => {
    vi.stubEnv('NUXT_WEB_TOOLS_DAILY_LIMIT', '0')
    expect(getWebToolLimits(20).daily).toBe(20)
  })
})

describe('getWebToolAvailability', () => {
  it('reports each tool by its own upstream key', () => {
    vi.stubEnv('STAAN_API_KEY', 'k')
    vi.stubEnv('JINA_AI_API_KEY', '')
    expect(getWebToolAvailability()).toEqual({ search: true, fetch: false })
    expect(isWebToolAvailable('web_search')).toBe(true)
    expect(isWebToolAvailable('fetch_url')).toBe(false)
  })

  it('treats a whitespace-only key as missing', () => {
    vi.stubEnv('STAAN_API_KEY', '   ')
    vi.stubEnv('JINA_AI_API_KEY', '   ')
    expect(getWebToolAvailability()).toEqual({ search: false, fetch: false })
  })
})

describe('consumeWebToolQuota', () => {
  beforeEach(() => {
    vi.stubEnv('NUXT_WEB_TOOLS_HOURLY_LIMIT', '3')
    vi.stubEnv('NUXT_WEB_TOOLS_DAILY_LIMIT', '7')
  })

  it('counts one call against both windows, keyed on the user', async () => {
    await consumeWebToolQuota(42)
    expect(checkRateLimit).toHaveBeenCalledWith('web-tools-hour', '42', 3, 60 * 60 * 1000)
    expect(checkRateLimit).toHaveBeenCalledWith('web-tools-day', '42', 7, 24 * 60 * 60 * 1000)
  })

  it('throws 429 with the hourly i18n key when the hour is full', async () => {
    checkRateLimit.mockImplementation(async ns => ns !== 'web-tools-hour')
    await expect(consumeWebToolQuota(1)).rejects.toMatchObject({
      statusCode: 429,
      data: { code: WEB_TOOLS_RATE_LIMITED_CODE, messageKey: 'ai.webToolsHourlyLimit', window: 'hourly', limit: 3 }
    })
  })

  it('throws 429 with the daily i18n key when the day is full', async () => {
    checkRateLimit.mockImplementation(async ns => ns !== 'web-tools-day')
    await expect(consumeWebToolQuota(1)).rejects.toMatchObject({
      statusCode: 429,
      data: { code: WEB_TOOLS_RATE_LIMITED_CODE, messageKey: 'ai.webToolsDailyLimit', window: 'daily', limit: 7 }
    })
  })

  it('skips a window whose limit is 0 (unlimited)', async () => {
    vi.stubEnv('NUXT_WEB_TOOLS_DAILY_LIMIT', '0')
    await consumeWebToolQuota(1)
    expect(checkRateLimit).toHaveBeenCalledTimes(1)
    expect(checkRateLimit).toHaveBeenCalledWith('web-tools-hour', '1', 3, 60 * 60 * 1000)
  })

  it('applies the user\'s plan daily limit when it is stricter', async () => {
    planWebToolsPerDay.value = 2
    await consumeWebToolQuota(5)
    expect(checkRateLimit).toHaveBeenCalledWith('web-tools-day', '5', 2, 24 * 60 * 60 * 1000)
  })

  it('does not limit a key-less harness call (no user id)', async () => {
    await consumeWebToolQuota(null)
    await consumeWebToolQuota(undefined)
    expect(checkRateLimit).not.toHaveBeenCalled()
  })
})
