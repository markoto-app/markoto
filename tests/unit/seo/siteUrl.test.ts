import { describe, expect, it } from 'vitest'
import { emailLinkBaseUrl } from '../../../server/utils/platform/siteUrl'
import { bootProblems } from '../env/fixtures'

// Email links are built from NUXT_SITE_URL only — never from the
// client-influenced request Host — so production must configure it.

describe('NUXT_SITE_URL at boot', () => {
  it('requires NUXT_SITE_URL in production', () => {
    expect(bootProblems({ NODE_ENV: 'production' })).toEqual(['NUXT_SITE_URL: required, not set'])
    expect(bootProblems({ NODE_ENV: 'production', NUXT_SITE_URL: 'https://markoto.app' })).toEqual([])
  })

  it('does not require it outside production', () => {
    expect(bootProblems({})).toEqual([])
  })

  it('rejects malformed values everywhere', () => {
    expect(bootProblems({ NUXT_SITE_URL: 'markoto.app' })).toHaveLength(1)
    expect(bootProblems({ NODE_ENV: 'production', NUXT_SITE_URL: 'ftp://markoto.app' })).toHaveLength(1)
  })
})

describe('emailLinkBaseUrl', () => {
  it('returns the configured origin', () => {
    expect(emailLinkBaseUrl('https://markoto.app')).toBe('https://markoto.app')
    expect(emailLinkBaseUrl('https://markoto.app/')).toBe('https://markoto.app')
    expect(emailLinkBaseUrl(' http://localhost:3000 ')).toBe('http://localhost:3000')
  })

  it('returns null (= do not send) when unset or unusable — never a request-derived host', () => {
    expect(emailLinkBaseUrl('')).toBeNull()
    expect(emailLinkBaseUrl(undefined)).toBeNull()
    expect(emailLinkBaseUrl('javascript:alert(1)')).toBeNull()
    expect(emailLinkBaseUrl('nope')).toBeNull()
  })
})
