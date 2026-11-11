import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MINIMAL_INSTANCE_CONFIG,
  loginPath,
  resolveInstanceConfig,
  resolveLegalSurfacesEnabled,
  resolveLoginProviders,
  resolveMarketingSiteEnabled,
  resolveSiteUrl,
  resolveDocsCanonicalBase,
  resolveSiteIndexable,
  resolveCanonicalSiteUrl,
  DEFAULT_DOCS_CANONICAL_BASE
} from '../../shared/config/instance'
import {
  abuseNotificationRecipient,
  assertLegalSurfacesEnabled,
  legalSurfacesEnabled,
  LEGAL_DISABLED_CODE
} from '../../server/utils/instanceConfig'
import { legalEntityErrors, resolveLegalEntity } from '../../shared/legal/entity'

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

  it('loginPath points at the auth handler', () => {
    expect(loginPath('google')).toBe('/auth/google')
    expect(loginPath('oidc')).toBe('/auth/oidc')
  })

  it('offers OIDC only with issuer + id + secret, first in display order', () => {
    const oidc = {
      NUXT_OAUTH_OIDC_ISSUER: 'https://idp.example.org',
      NUXT_OAUTH_OIDC_CLIENT_ID: 'markoto',
      NUXT_OAUTH_OIDC_CLIENT_SECRET: 'secret'
    }
    expect(resolveLoginProviders(oidc)).toEqual(['oidc'])
    expect(resolveLoginProviders({ ...oidc, NUXT_OAUTH_OIDC_ISSUER: '' })).toEqual([])
    expect(resolveLoginProviders({ ...oidc, NUXT_OAUTH_GITHUB_CLIENT_ID: 'h', NUXT_OAUTH_GITHUB_CLIENT_SECRET: 'hs' }))
      .toEqual(['oidc', 'github'])
  })

  it('carries the OIDC button name, trimmed and capped', () => {
    expect(resolveInstanceConfig({ NUXT_OAUTH_OIDC_NAME: '  Authentik ' }).oidcProviderName).toBe('Authentik')
    expect(resolveInstanceConfig({ NUXT_OAUTH_OIDC_NAME: 'x'.repeat(100) }).oidcProviderName).toHaveLength(40)
    expect(resolveInstanceConfig({}).oidcProviderName).toBe('')
  })
})

describe('resolveInstanceConfig', () => {
  it('defaults to the self-hosted shape: no legal surfaces, no operator name', () => {
    // Self-hosted: every committed tier includes per-workspace SSO (WP14).
    expect(resolveInstanceConfig({})).toEqual({ ...MINIMAL_INSTANCE_CONFIG, workspaceSso: true })
    expect(resolveLegalSurfacesEnabled({ NUXT_LEGAL_SURFACES_ENABLED: 'nope' })).toBe(false)
  })

  it('self-hosted never shows the hosted operator, only an explicitly configured name', () => {
    expect(resolveInstanceConfig({ NUXT_LEGAL_CONTROLLER_NAME: ' Example Org ' }).operatorName).toBe('Example Org')
    expect(resolveInstanceConfig({}).operatorName).not.toContain('LatentSpace')
  })

  it('anonymous gate follows the legal surfaces unless set explicitly', () => {
    expect(resolveInstanceConfig({}).anonGate).toBe(false)
    expect(resolveInstanceConfig({ NUXT_LEGAL_SURFACES_ENABLED: 'true' }).anonGate).toBe(true)
    expect(resolveInstanceConfig({ NUXT_ANON_GATE_ENABLED: 'true' }).anonGate).toBe(true)
    expect(resolveInstanceConfig({ NUXT_LEGAL_SURFACES_ENABLED: 'true', NUXT_ANON_GATE_ENABLED: 'false' }).anonGate).toBe(false)
  })

  it('carries the anonymous-document retention (default 30 days)', () => {
    expect(resolveInstanceConfig({}).anonDocTtlDays).toBe(30)
    expect(resolveInstanceConfig({ NUXT_INACTIVE_DOC_TTL_DAYS: '0' }).anonDocTtlDays).toBe(0)
  })

  it('hosted shape: legal surfaces on, operator = legal entity (default or override)', () => {
    expect(resolveInstanceConfig({ NUXT_LEGAL_SURFACES_ENABLED: 'true' }))
      .toMatchObject({ legalSurfaces: true, operatorName: 'LatentSpace Labs GmbH' })
    expect(resolveInstanceConfig({ NUXT_LEGAL_SURFACES_ENABLED: '1', NUXT_LEGAL_CONTROLLER_NAME: 'Acme AG' }).operatorName)
      .toBe('Acme AG')
  })

  it('marketing site is off unless NUXT_MARKETING_SITE_ENABLED is truthy (hosted only)', () => {
    expect(resolveInstanceConfig({}).marketingSite).toBe(false)
    expect(resolveMarketingSiteEnabled({ NUXT_MARKETING_SITE_ENABLED: 'nope' })).toBe(false)
    expect(resolveMarketingSiteEnabled({ NUXT_MARKETING_SITE_ENABLED: ' TRUE ' })).toBe(true)
    expect(resolveInstanceConfig({ NUXT_MARKETING_SITE_ENABLED: '1' }).marketingSite).toBe(true)
  })

  it('still honours the former NUXT_PRODUCT_TOUR_ENABLED while the new flag is unset (alias)', () => {
    expect(resolveMarketingSiteEnabled({ NUXT_PRODUCT_TOUR_ENABLED: 'true' })).toBe(true)
    expect(resolveMarketingSiteEnabled({ NUXT_PRODUCT_TOUR_ENABLED: 'true', NUXT_MARKETING_SITE_ENABLED: '' })).toBe(true)
    // The new name wins when both are set.
    expect(resolveMarketingSiteEnabled({ NUXT_PRODUCT_TOUR_ENABLED: 'true', NUXT_MARKETING_SITE_ENABLED: 'false' })).toBe(false)
    expect(resolveMarketingSiteEnabled({ NUXT_PRODUCT_TOUR_ENABLED: 'false', NUXT_MARKETING_SITE_ENABLED: 'true' })).toBe(true)
  })

  it('site URL is the origin of NUXT_SITE_URL, empty when unset or invalid', () => {
    expect(resolveSiteUrl({})).toBe('')
    expect(resolveSiteUrl({ NUXT_SITE_URL: 'https://markoto.app/' })).toBe('https://markoto.app')
    expect(resolveSiteUrl({ NUXT_SITE_URL: ' http://10.0.0.5:8080/x ' })).toBe('http://10.0.0.5:8080')
    expect(resolveSiteUrl({ NUXT_SITE_URL: 'not a url' })).toBe('')
    expect(resolveSiteUrl({ NUXT_SITE_URL: 'ftp://example.com' })).toBe('')
    expect(resolveInstanceConfig({ NUXT_SITE_URL: 'https://docs.example.com' }).siteUrl).toBe('https://docs.example.com')
  })

  it('docs canonical base: markoto.app off-hosted, self on the marketing site, empty env = self', () => {
    expect(DEFAULT_DOCS_CANONICAL_BASE).toBe('https://markoto.app')
    expect(resolveDocsCanonicalBase({})).toBe('https://markoto.app')
    expect(resolveDocsCanonicalBase({ NUXT_MARKETING_SITE_ENABLED: 'true' })).toBe('')
    expect(resolveDocsCanonicalBase({ NUXT_DOCS_CANONICAL_BASE: '' })).toBe('')
    expect(resolveDocsCanonicalBase({ NUXT_DOCS_CANONICAL_BASE: 'https://docs.example.com/' })).toBe('https://docs.example.com')
    expect(resolveDocsCanonicalBase({ NUXT_DOCS_CANONICAL_BASE: 'garbage' })).toBe('https://markoto.app')
    expect(resolveInstanceConfig({}).docsCanonicalBase).toBe('https://markoto.app')
  })

  it('SEO origin: NUXT_CANONICAL_SITE_URL when valid, else the site URL', () => {
    expect(resolveCanonicalSiteUrl({ NUXT_SITE_URL: 'https://staging.markoto.app' })).toBe('https://staging.markoto.app')
    expect(resolveCanonicalSiteUrl({ NUXT_SITE_URL: 'https://staging.markoto.app', NUXT_CANONICAL_SITE_URL: '' })).toBe('https://staging.markoto.app')
    expect(resolveCanonicalSiteUrl({ NUXT_SITE_URL: 'https://staging.markoto.app', NUXT_CANONICAL_SITE_URL: 'https://markoto.app/' })).toBe('https://markoto.app')
    expect(resolveCanonicalSiteUrl({ NUXT_SITE_URL: 'https://staging.markoto.app', NUXT_CANONICAL_SITE_URL: 'garbage' })).toBe('https://staging.markoto.app')
    expect(resolveInstanceConfig({ NUXT_SITE_URL: 'https://staging.markoto.app', NUXT_CANONICAL_SITE_URL: 'https://markoto.app' }).siteUrl).toBe('https://markoto.app')
  })

  it('site is indexable unless NUXT_SITE_INDEXABLE is an explicit false', () => {
    expect(resolveSiteIndexable({})).toBe(true)
    expect(resolveSiteIndexable({ NUXT_SITE_INDEXABLE: '' })).toBe(true)
    expect(resolveSiteIndexable({ NUXT_SITE_INDEXABLE: 'true' })).toBe(true)
    expect(resolveSiteIndexable({ NUXT_SITE_INDEXABLE: 'flase' })).toBe(true)
    for (const v of ['false', ' FALSE ', '0', 'no', 'off']) {
      expect(resolveSiteIndexable({ NUXT_SITE_INDEXABLE: v }), v).toBe(false)
    }
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

describe('legal entity defaults', () => {
  it('ships no personal name or street address as a default', () => {
    const entity = resolveLegalEntity({})
    expect(entity.controllerAddress).toBe('')
    expect(entity.representedBy).toBe('')
    expect(entity.controllerName).toBe('LatentSpace Labs GmbH')
  })

  it('requires address and representative from the environment', () => {
    expect(legalEntityErrors({})).toHaveLength(2)
    expect(legalEntityErrors({
      NUXT_LEGAL_CONTROLLER_ADDRESS: '1 Example Street, 8000 Zurich',
      NUXT_LEGAL_REPRESENTED_BY: 'Jane Doe'
    })).toEqual([])
  })
})
