import { describe, it, expect } from 'vitest'
import { isRateLimitBypassed, isTestModeEnabled, productionSignals, testModeBootError } from '../../../shared/utils/security/testMode'

// TEST_MODE=1 unlocks the /api/_test/* login shim (log in as any user),
// skips boot-time secret validation and disables rate limits. It must
// only ever take effect in the test harnesses, never on a deployment
// that has a stray TEST_MODE=1 in its env.

describe('isTestModeEnabled', () => {
  it('is off without TEST_MODE', () => {
    expect(isTestModeEnabled({})).toBe(false)
    expect(isTestModeEnabled({ TEST_MODE: '0' })).toBe(false)
  })

  it('is on for the test harness shapes (no site URL, or a loopback one)', () => {
    expect(isTestModeEnabled({ TEST_MODE: '1' })).toBe(true)
    expect(isTestModeEnabled({ TEST_MODE: '1', NUXT_SITE_URL: '' })).toBe(true)
    expect(isTestModeEnabled({ TEST_MODE: '1', NUXT_SITE_URL: 'http://localhost:3001' })).toBe(true)
    expect(isTestModeEnabled({ TEST_MODE: '1', NUXT_SITE_URL: 'http://127.0.0.1:3101' })).toBe(true)
    expect(isTestModeEnabled({ TEST_MODE: '1', NUXT_SITE_URL: 'http://[::1]:3000' })).toBe(true)
    expect(isTestModeEnabled({ TEST_MODE: '1', NUXT_SITE_URL: 'http://markoto.localhost' })).toBe(true)
  })

  it('is OFF when the instance looks like a real deployment, even with TEST_MODE=1', () => {
    expect(isTestModeEnabled({ TEST_MODE: '1', NODE_ENV: 'production', NUXT_SITE_URL: 'https://markoto.app' })).toBe(false)
    expect(isTestModeEnabled({ TEST_MODE: '1', NUXT_SITE_URL: 'http://192.168.1.10:8080' })).toBe(false)
    expect(isTestModeEnabled({ TEST_MODE: '1', NUXT_SITE_URL: 'https://localhost.example.com' })).toBe(false)
    expect(isTestModeEnabled({ TEST_MODE: '1', NUXT_SITE_URL: 'not a url' })).toBe(false)
  })
})

describe('testModeBootError', () => {
  it('is null without TEST_MODE, whatever the site URL', () => {
    expect(testModeBootError({ NUXT_SITE_URL: 'https://markoto.app' })).toBeNull()
  })

  it('is null for the test harness shape', () => {
    expect(testModeBootError({ TEST_MODE: '1', NODE_ENV: 'production' })).toBeNull()
  })

  it('refuses to boot with TEST_MODE=1 on a real deployment', () => {
    const error = testModeBootError({ TEST_MODE: '1', NUXT_SITE_URL: 'https://docs.example.org' })
    expect(error).toContain('TEST_MODE=1')
    expect(error).toContain('docs.example.org')
  })

  it('productionSignals names every reason', () => {
    expect(productionSignals({ NUXT_SITE_URL: 'https://docs.example.org' })).toHaveLength(1)
    expect(productionSignals({})).toEqual([])
  })
})

describe('isRateLimitBypassed', () => {
  it('never bypasses outside test mode, whatever TEST_ENFORCE_RATE_LIMITS says', () => {
    expect(isRateLimitBypassed('mcp-token', {})).toBe(false)
    expect(isRateLimitBypassed('mcp-token', { TEST_ENFORCE_RATE_LIMITS: '' })).toBe(false)
    expect(isRateLimitBypassed('mcp-token', { TEST_MODE: '1', NUXT_SITE_URL: 'https://docs.example.org' })).toBe(false)
  })

  it('bypasses every namespace in test mode by default', () => {
    expect(isRateLimitBypassed('mcp-token', { TEST_MODE: '1' })).toBe(true)
    expect(isRateLimitBypassed('doc-password', { TEST_MODE: '1' })).toBe(true)
  })

  it('enforces only the listed namespaces in test mode', () => {
    const env = { TEST_MODE: '1', TEST_ENFORCE_RATE_LIMITS: 'mcp-client, mcp-token' }
    expect(isRateLimitBypassed('mcp-client', env)).toBe(false)
    expect(isRateLimitBypassed('mcp-token', env)).toBe(false)
    expect(isRateLimitBypassed('mcp-tool-user', env)).toBe(true)
    expect(isRateLimitBypassed('doc-password', env)).toBe(true)
  })

  it('enforces everything with *', () => {
    expect(isRateLimitBypassed('doc-password', { TEST_MODE: '1', TEST_ENFORCE_RATE_LIMITS: '*' })).toBe(false)
  })
})
