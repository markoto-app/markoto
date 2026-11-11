import { describe, expect, it } from 'vitest'
import { emailLinkBaseUrl, siteUrlErrors } from '../../../server/utils/platform/siteUrl'

// Email links are built from NUXT_SITE_URL only — never from the
// client-influenced request Host — so production must configure it.

describe('siteUrlErrors', () => {
  it('requires NUXT_SITE_URL in production', () => {
    expect(siteUrlErrors('', true)).toHaveLength(1)
    expect(siteUrlErrors(undefined, true)).toHaveLength(1)
    expect(siteUrlErrors('https://markoto.app', true)).toEqual([])
  })

  it('does not require it outside production', () => {
    expect(siteUrlErrors('', false)).toEqual([])
  })

  it('rejects malformed values everywhere', () => {
    expect(siteUrlErrors('markoto.app', false)).toHaveLength(1)
    expect(siteUrlErrors('ftp://markoto.app', true)).toHaveLength(1)
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
