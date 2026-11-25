import { describe, it, expect, vi } from 'vitest'
import { loginReturnFrom } from '../../../shared/utils/security/loginReturn'
import { loginPath } from '../../../shared/config/instance'
import { adoptedToast, signInMarkers } from '../../../app/utils/account/signInReturn'

vi.mock('../../../server/utils/platform/valkey', () => ({ useValkey: () => ({}) }))
const { signedInLanding } = await import('../../../server/utils/auth/loginReturn')

// The return path every sign-in link carries (the editor's "Sign in" comes
// back to the document) and the markers the callback adds for the client.

describe('loginReturnFrom', () => {
  it('keeps a page of this site and drops the home page', () => {
    expect(loginReturnFrom('/d/abc?x=1')).toBe('/d/abc?x=1')
    expect(loginReturnFrom('/')).toBeNull()
  })

  it('drops the markers of an earlier sign-in, so they can\'t fire twice', () => {
    expect(loginReturnFrom('/d/abc?signed_in=1&linked=github&signed_up=google&x=1')).toBe('/d/abc?x=1')
    expect(loginReturnFrom('/?signed_in=1')).toBeNull()
  })

  it('refuses anything off the site', () => {
    for (const bad of ['//evil.example', '/\\evil.example', '/auth/github', '/api/user']) expect(loginReturnFrom(bad), bad).toBeNull()
  })
})

describe('loginPath', () => {
  it('carries the page as `return`, and nothing for the home page or a refused path', () => {
    expect(loginPath('github')).toBe('/auth/github')
    expect(loginPath('github', '/')).toBe('/auth/github')
    expect(loginPath('google', '/d/abc')).toBe(`/auth/google?return=${encodeURIComponent('/d/abc')}`)
    expect(loginPath('oidc', '//evil.example')).toBe('/auth/oidc')
  })
})

describe('signedInLanding', () => {
  it('marks the landing page for the client', () => {
    expect(signedInLanding('/d/abc', 'github', 'updated')).toBe('/d/abc?signed_in=1')
    expect(signedInLanding(null, 'google', 'inserted')).toBe('/?signed_up=google&signed_in=1')
    expect(signedInLanding('/w/ws1', 'sso', 'existing')).toBe('/w/ws1?signed_in=1')
    expect(signedInLanding('/pricing?plan=pro', 'oidc', 'merged')).toBe('/pricing?plan=pro&linked=oidc&signed_in=1')
  })
})

describe('client markers', () => {
  it('reads a sign-in only from signed_in=1, and a known linked provider', () => {
    expect(signInMarkers(new URLSearchParams(''))).toBeNull()
    expect(signInMarkers(new URLSearchParams('signed_in=yes'))).toBeNull()
    expect(signInMarkers(new URLSearchParams('signed_in=1'))).toEqual({ linked: null })
    expect(signInMarkers(new URLSearchParams('signed_in=1&linked=google'))).toEqual({ linked: 'google' })
    expect(signInMarkers(new URLSearchParams('signed_in=1&linked=evil'))).toEqual({ linked: null })
  })

  it('announces only a positive whole number of adopted documents', () => {
    expect(adoptedToast(2)).toBe(2)
    for (const none of [0, -1, 1.5, '2', null, undefined]) expect(adoptedToast(none)).toBe(0)
  })
})
