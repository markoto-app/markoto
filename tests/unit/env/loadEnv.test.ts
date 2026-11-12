import { describe, expect, it, vi } from 'vitest'
import { EnvError, loadEnv, useEnv } from '../../../shared/env/load'
import { bootProblems, bootWarnings, VALID_APP_ENV, VALID_SYNC_ENV } from './fixtures'

// loadEnv: the typed, validated environment of one process. Boot fails
// with every problem at once, one line each, never a value.

describe('loadEnv', () => {
  it('boots the valid fixture and returns a typed, frozen, namespaced object', () => {
    expect(bootProblems({})).toEqual([])
    const env = loadEnv('app', { ...VALID_APP_ENV, NUXT_BILLING_ENABLED: 'yes', NUXT_WEB_TOOLS_DAILY_LIMIT: '7' })
    expect(env.billing.enabled).toBe(true)
    expect(env.providers.webToolsDailyLimit).toBe(7)
    expect(env.storage.bucket).toBe('ypad')
    expect(Object.isFrozen(env)).toBe(true)
    expect(Object.isFrozen(env.billing)).toBe(true)
  })

  it('reports every problem at once, one line per variable', () => {
    const problems = bootProblems({ NUXT_JWT_SECRET: undefined, NUXT_SITE_INDEXABLE: 'maybe', SYNC_MAX_MESSAGE_BYTES: '1', NUXT_INACTIVE_DOC_TTL_DAYS: '-1' })
    expect(problems).toEqual([
      'NUXT_JWT_SECRET: required, not set',
      'NUXT_SITE_INDEXABLE: expected a boolean (true/false, 1/0, yes/no, on/off)',
      'NUXT_INACTIVE_DOC_TTL_DAYS: expected an integer ≥ 0'
    ])
  })

  it('never prints a secret value', () => {
    try {
      loadEnv('app', { ...VALID_APP_ENV, NUXT_SESSION_PASSWORD: 'tooshort-but-secret' })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError)
      expect((e as EnvError).message).toContain('NUXT_SESSION_PASSWORD: expected at least 32 characters (got 19)')
      expect((e as EnvError).message).not.toContain('tooshort-but-secret')
      expect((e as EnvError).message).toContain('docs/reference/configuration.md')
    }
  })

  it('treats an empty value as unset (the default applies)', () => {
    expect(loadEnv('app', { ...VALID_APP_ENV, NUXT_INACTIVE_DOC_TTL_DAYS: '  ' }).legal.inactiveDocTtlDays).toBe(30)
  })

  it('enforces production-only requirements under NODE_ENV=production', () => {
    expect(bootProblems({ NODE_ENV: 'production' })).toContain('NUXT_SITE_URL: required, not set')
    expect(bootProblems({ NODE_ENV: 'production', NUXT_SITE_URL: 'https://docs.example.org' })).toEqual([])
  })

  it('test mode relaxes required values, never types', () => {
    const testMode = { TEST_MODE: '1', NUXT_JWT_SECRET: undefined }
    expect(bootProblems(testMode)).toEqual([])
    expect(bootProblems({ ...testMode, NUXT_SITE_INDEXABLE: 'maybe' })).toEqual(['NUXT_SITE_INDEXABLE: expected a boolean (true/false, 1/0, yes/no, on/off)'])
  })

  it('refuses TEST_MODE on a real deployment', () => {
    expect(bootProblems({ TEST_MODE: '1', NUXT_SITE_URL: 'https://docs.example.org' }).join('\n')).toMatch(/TEST_MODE/)
  })

  it('reads the sync server\'s names for shared values', () => {
    const env = loadEnv('sync', { ...VALID_SYNC_ENV, SYNC_MAX_UPDATE_BYTES: '1024' })
    expect(env.auth.jwtSecret).toBe(VALID_SYNC_ENV.JWT_SECRET)
    expect(env.sync.maxUpdateBytes).toBe(1024)
    expect(bootProblems({ JWT_SECRET: undefined }, 'sync')).toEqual(['JWT_SECRET: required, not set'])
    expect('billing' in env).toBe(false)
  })
})

describe('cross-field rules', () => {
  it('OAuth and OIDC credentials come in complete sets', () => {
    expect(bootProblems({ NUXT_OAUTH_GITHUB_CLIENT_ID: 'id' })).toEqual([
      'NUXT_OAUTH_GITHUB_CLIENT_ID and NUXT_OAUTH_GITHUB_CLIENT_SECRET must be set together (got: id=set, secret=empty)'
    ])
    expect(bootProblems({ NUXT_OAUTH_OIDC_ISSUER: 'https://id.example.org' }).join('\n')).toMatch(/NUXT_OAUTH_OIDC_CLIENT_ID and NUXT_OAUTH_OIDC_CLIENT_SECRET must be set together/)
  })

  it('billing on in production needs the Stripe keys', () => {
    const prod = { NODE_ENV: 'production', NUXT_SITE_URL: 'https://docs.example.org', NUXT_BILLING_ENABLED: 'true' }
    expect(bootProblems(prod)).toEqual([
      'NUXT_STRIPE_SECRET_KEY is required when NUXT_BILLING_ENABLED=true in production',
      'NUXT_STRIPE_WEBHOOK_SECRET is required when NUXT_BILLING_ENABLED=true in production'
    ])
    expect(bootProblems({ ...prod, NUXT_STRIPE_SECRET_KEY: 'sk', NUXT_STRIPE_WEBHOOK_SECRET: 'whsec' })).toEqual([])
    expect(bootProblems({ NUXT_BILLING_ENABLED: 'true' })).toEqual([])
  })

  it('the hosted shape needs the operator identity, the BYOK allowlist, a pages host and the ALTCHA key', () => {
    const problems = bootProblems({ NUXT_LEGAL_SURFACES_ENABLED: 'true' })
    for (const name of ['NUXT_LEGAL_CONTROLLER_ADDRESS', 'NUXT_LEGAL_REPRESENTED_BY', 'NUXT_AI_BYOK_ALLOWED_BASE_URLS', 'NUXT_PUBLISH_PAGES_HOST', 'NUXT_ALTCHA_HMAC_KEY']) {
      expect(problems.some(p => p.startsWith(name)), name).toBe(true)
    }
  })

  it('rules wait until every value parses (no follow-up noise)', () => {
    expect(bootProblems({ NUXT_LEGAL_SURFACES_ENABLED: 'maybe' })).toHaveLength(1)
  })

  it('a half-configured AI instance default is a warning, not a boot failure', () => {
    expect(bootProblems({ NUXT_AI_DEFAULT_CHAT_BASE_URL: 'https://api.example.org/v1' })).toEqual([])
    expect(bootWarnings({ NUXT_AI_DEFAULT_CHAT_BASE_URL: 'https://api.example.org/v1' })).toEqual([
      'NUXT_AI_DEFAULT_CHAT_BASE_URL/_API_KEY set without NUXT_AI_DEFAULT_CHAT_MODEL — the chat default is ignored.'
    ])
  })
})

describe('useEnv (runtime reads)', () => {
  it('re-reads process.env under Vitest, so a test stubs configuration like an operator sets it', () => {
    vi.stubEnv('NUXT_WEB_TOOLS_HOURLY_LIMIT', '3')
    expect(useEnv().providers.webToolsHourlyLimit).toBe(3)
    vi.stubEnv('NUXT_WEB_TOOLS_HOURLY_LIMIT', '4')
    expect(useEnv().providers.webToolsHourlyLimit).toBe(4)
  })

  it('does not enforce required values (boot did) but still refuses a bad type', () => {
    vi.stubEnv('NUXT_JWT_SECRET', undefined)
    expect(useEnv().auth.jwtSecret).toBe('')
    vi.stubEnv('NUXT_WEB_TOOLS_HOURLY_LIMIT', 'lots')
    expect(() => useEnv()).toThrow(EnvError)
  })
})
