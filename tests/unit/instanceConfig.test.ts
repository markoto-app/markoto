import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MINIMAL_INSTANCE_CONFIG,
  loginPath,
  resolveInstanceConfig,
  resolveLegalSurfacesEnabled,
  resolveLoginProviders
} from '../../shared/config/instance'
import {
  abuseNotificationRecipient,
  assertLegalSurfacesEnabled,
  legalSurfacesEnabled,
  LEGAL_DISABLED_CODE
} from '../../server/utils/instanceConfig'

// Instance shape (WP7): which login providers are offered and whether the
// hosted service's legal surfaces exist. Self-hosted is the default; the
// hosted SaaS opts in via NUXT_LEGAL_SURFACES_ENABLED.

describe('resolveLoginProviders', () => {
  it('offers nothing without OAuth apps (anonymous-only self-host)', () => {
    expect(resolveLoginProviders({})).toEqual([])
  })

  it('needs BOTH id and secret per provider', () => {
    expect(resolveLoginProviders({ NUXT_OAUTH_GITHUB_CLIENT_ID: 'id' })).toEqual([])
    expect(resolveLoginProviders({ NUXT_OAUTH_GOOGLE_CLIENT_SECRET: 'secret' })).toEqual([])
    expect(resolveLoginProviders({ NUXT_OAUTH_GITHUB_CLIENT_ID: ' ', NUXT_OAUTH_GITHUB_CLIENT_SECRET: 's' })).toEqual([])
  })

  it('lists configured providers in display order (github, google)', () => {
    expect(resolveLoginProviders({
      NUXT_OAUTH_GOOGLE_CLIENT_ID: 'g',
      NUXT_OAUTH_GOOGLE_CLIENT_SECRET: 'gs',
      NUXT_OAUTH_GITHUB_CLIENT_ID: 'h',
      NUXT_OAUTH_GITHUB_CLIENT_SECRET: 'hs'
    })).toEqual(['github', 'google'])
    expect(resolveLoginProviders({ NUXT_OAUTH_GOOGLE_CLIENT_ID: 'g', NUXT_OAUTH_GOOGLE_CLIENT_SECRET: 'gs' }))
      .toEqual(['google'])
  })

  it('loginPath points at the nuxt-auth-utils handler', () => {
    expect(loginPath('google')).toBe('/auth/google')
  })
})

describe('resolveInstanceConfig', () => {
  it('defaults to the self-hosted shape: no legal surfaces, no operator name', () => {
    expect(resolveInstanceConfig({})).toEqual(MINIMAL_INSTANCE_CONFIG)
    expect(resolveLegalSurfacesEnabled({ NUXT_LEGAL_SURFACES_ENABLED: 'nope' })).toBe(false)
  })

  it('self-hosted never shows the hosted operator, only an explicitly configured name', () => {
    expect(resolveInstanceConfig({ NUXT_LEGAL_CONTROLLER_NAME: ' Example Org ' }).operatorName).toBe('Example Org')
    expect(resolveInstanceConfig({}).operatorName).not.toContain('LatentSpace')
  })

  it('hosted shape: legal surfaces on, operator = legal entity (default or override)', () => {
    expect(resolveInstanceConfig({ NUXT_LEGAL_SURFACES_ENABLED: 'true' }))
      .toMatchObject({ legalSurfaces: true, operatorName: 'LatentSpace Labs GmbH' })
    expect(resolveInstanceConfig({ NUXT_LEGAL_SURFACES_ENABLED: '1', NUXT_LEGAL_CONTROLLER_NAME: 'Acme AG' }).operatorName)
      .toBe('Acme AG')
  })
})

describe('server instance helpers', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('assertLegalSurfacesEnabled → 404 legal/disabled when off', () => {
    vi.stubEnv('NUXT_LEGAL_SURFACES_ENABLED', '')
    expect(legalSurfacesEnabled()).toBe(false)
    try {
      assertLegalSurfacesEnabled()
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toMatchObject({ statusCode: 404, data: { code: LEGAL_DISABLED_CODE } })
    }
  })

  it('assertLegalSurfacesEnabled passes when on', () => {
    vi.stubEnv('NUXT_LEGAL_SURFACES_ENABLED', 'true')
    expect(() => assertLegalSurfacesEnabled()).not.toThrow()
  })

  it('abuse notifications never go to the hosted inbox from a self-hosted instance', () => {
    vi.stubEnv('NUXT_LEGAL_SURFACES_ENABLED', 'false')
    vi.stubEnv('NUXT_LEGAL_ABUSE_CONTACT_EMAIL', '')
    expect(abuseNotificationRecipient()).toBeNull()
  })

  it('an explicit abuse inbox always wins', () => {
    vi.stubEnv('NUXT_LEGAL_SURFACES_ENABLED', 'false')
    vi.stubEnv('NUXT_LEGAL_ABUSE_CONTACT_EMAIL', 'abuse@example.org')
    expect(abuseNotificationRecipient()).toBe('abuse@example.org')
  })

  it('hosted (legal on) falls back to the legal entity default inbox', () => {
    vi.stubEnv('NUXT_LEGAL_SURFACES_ENABLED', 'true')
    vi.stubEnv('NUXT_LEGAL_ABUSE_CONTACT_EMAIL', '')
    expect(abuseNotificationRecipient()).toBe('abuse@markoto.app')
  })
})
