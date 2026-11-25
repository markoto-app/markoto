import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'
import { captureLogs } from '../../helpers/logs'
import { appendQueryParam, safeLoginReturnPath, withLoginReturn } from '../../../shared/utils/security/loginReturn'

// The page a sign-in returns to: only this site's own pages, parked in
// Valkey under the OAuth state on the start leg and taken back once on
// the callback.

const { store, valkey } = vi.hoisted(() => {
  const store = new Map<string, string>()
  return {
    store,
    valkey: {
      fail: false,
      set: vi.fn(async (key: string, value: string) => {
        if (valkey.fail) throw new Error('valkey down')
        store.set(key, value)
        return 'OK'
      }),
      getdel: vi.fn(async (key: string) => {
        if (valkey.fail) throw new Error('valkey down')
        const value = store.get(key) ?? null
        store.delete(key)
        return value
      })
    }
  }
})
vi.mock('../../../server/utils/platform/valkey', () => ({ useValkey: () => valkey }))

const { loginLandingPath, rememberLoginReturn } = await import('../../../server/utils/auth/loginReturn')

const logs = captureLogs()

function event(path: string, location?: string): H3Event {
  return { path, node: { res: { getHeader: (name: string) => (name === 'location' ? location : undefined) } } } as unknown as H3Event
}

beforeEach(() => {
  store.clear()
  valkey.fail = false
})

describe('safeLoginReturnPath', () => {
  it.each([
    ['/pricing', '/pricing'],
    ['/pricing?interval=year&currency=chf', '/pricing?interval=year&currency=chf'],
    ['/de/pricing?interval=year#plans', '/de/pricing?interval=year'],
    ['/w/abc?tab=settings', '/w/abc?tab=settings']
  ])('keeps a page of this site: %s', (value, expected) => {
    expect(safeLoginReturnPath(value)).toBe(expected)
  })

  it.each([
    '//evil.example/pricing',
    'https://evil.example/',
    '/\\evil.example',
    'pricing',
    '',
    '/pricing\nSet-Cookie: x=1',
    '/auth/github',
    '/auth',
    '/api/user',
    '/_internal/render',
    '/mcp',
    '/scim/v2/Users',
    `/${'a'.repeat(600)}`,
    42,
    null,
    ['/pricing']
  ])('refuses %j', (value) => {
    expect(safeLoginReturnPath(value)).toBeNull()
  })
})

describe('withLoginReturn / appendQueryParam', () => {
  it('adds the encoded return path to a sign-in path', () => {
    expect(withLoginReturn('/auth/github', '/pricing?interval=year')).toBe('/auth/github?return=%2Fpricing%3Finterval%3Dyear')
    expect(withLoginReturn('/auth/github?x=1', '/pricing')).toBe('/auth/github?x=1&return=%2Fpricing')
  })

  it('leaves the sign-in path alone without a safe return path', () => {
    expect(withLoginReturn('/auth/github', null)).toBe('/auth/github')
    expect(withLoginReturn('/auth/github', '//evil.example')).toBe('/auth/github')
  })

  it('appends a query parameter to a path with or without a query', () => {
    expect(appendQueryParam('/', 'signed_up', 'github')).toBe('/?signed_up=github')
    expect(appendQueryParam('/pricing?interval=year', 'signed_up', 'github')).toBe('/pricing?interval=year&signed_up=github')
  })
})

describe('rememberLoginReturn + loginLandingPath', () => {
  const start = (returnTo: string) => event(`/auth/github?return=${encodeURIComponent(returnTo)}`, 'https://github.com/login/oauth/authorize?client_id=x&state=st-1')
  const callback = (state = 'st-1') => event(`/auth/github?code=c&state=${state}`)

  it('a returning user comes back to the parked page, once', async () => {
    await rememberLoginReturn(start('/pricing?interval=year'))
    expect(await loginLandingPath(callback(), 'github', 'updated')).toBe('/pricing?interval=year')
    expect(await loginLandingPath(callback(), 'github', 'updated')).toBe('/')
  })

  it('a new account carries signed_up on the parked page or the home page', async () => {
    await rememberLoginReturn(start('/pricing?interval=year'))
    expect(await loginLandingPath(callback(), 'github', 'inserted')).toBe('/pricing?interval=year&signed_up=github')
    expect(await loginLandingPath(callback(), 'github', 'inserted')).toBe('/?signed_up=github')
  })

  it('a merged account always lands on the home page that explains the merge', async () => {
    await rememberLoginReturn(start('/pricing'))
    expect(await loginLandingPath(callback(), 'google', 'merged')).toBe('/?linked=google')
  })

  it('another sign-in attempt (another state) does not get the page', async () => {
    await rememberLoginReturn(start('/pricing'))
    expect(await loginLandingPath(callback('st-2'), 'github', 'updated')).toBe('/')
    expect(await loginLandingPath(event('/auth/github?code=c'), 'github', 'updated')).toBe('/')
  })

  it('parks nothing for an unsafe path, without a redirect, or with the state given by the caller', async () => {
    await rememberLoginReturn(start('//evil.example'))
    await rememberLoginReturn(event('/auth/github?return=%2Fpricing'))
    await rememberLoginReturn(event('/auth/github?return=%2Fpricing', 'not a url'))
    expect(valkey.set).not.toHaveBeenCalledWith(expect.anything(), '//evil.example', expect.anything(), expect.anything())
    expect(store.size).toBe(0)
    await rememberLoginReturn(event('/auth/oidc?return=%2Fpricing'), 'oidc-state')
    expect(await loginLandingPath(event('/auth/oidc?code=c&state=oidc-state'), 'oidc', 'updated')).toBe('/pricing')
  })

  it('without Valkey the sign-in still works and lands on the home page', async () => {
    valkey.fail = true
    await rememberLoginReturn(start('/pricing'))
    expect(await loginLandingPath(callback(), 'github', 'updated')).toBe('/')
    expect(logs.find('warn', 'could not park the sign-in return path')).toBeTruthy()
    expect(logs.find('warn', 'could not read the sign-in return path')).toBeTruthy()
  })
})
