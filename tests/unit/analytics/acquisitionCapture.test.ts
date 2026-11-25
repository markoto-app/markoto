import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'
import { stubEnv } from '../../helpers/env'

// Server side of the acquisition source (server/utils/analytics/acquisitionSource.ts):
// the analytics flag, GPC / DNT, the OAuth hand-over through Valkey and the
// checkout mark. Repos and Valkey are faked; the SQL side is in
// tests/repos/acquisitionFunnel.test.ts.

const repo = vi.hoisted(() => ({
  getAccountAcquisitionSource: vi.fn(async () => 'producthunt' as string | null),
  recordAccountAcquisitionSource: vi.fn(async () => true),
  recordCheckoutStarted: vi.fn(async () => {})
}))
vi.mock('../../../server/repos/acquisition', () => repo)

const store = vi.hoisted(() => new Map<string, string>())
const valkey = vi.hoisted(() => ({
  set: vi.fn(async (k: string, v: string) => {
    store.set(k, v)
    return 'OK'
  }),
  getdel: vi.fn(async (k: string) => {
    const v = store.get(k) ?? null
    store.delete(k)
    return v
  })
}))
vi.mock('../../../server/utils/platform/valkey', () => ({ useValkey: () => valkey }))

interface FakeEvent { headers: Record<string, string>, query: Record<string, string>, location?: string }
const fake = (e: FakeEvent): H3Event => ({ node: { res: { getHeader: (n: string) => (n === 'location' ? e.location : undefined) } }, __fake: e }) as unknown as H3Event
vi.stubGlobal('getRequestHeader', (event: { __fake: FakeEvent }, name: string) => event.__fake.headers[name.toLowerCase()])
vi.stubGlobal('getQuery', (event: { __fake: FakeEvent }) => event.__fake.query)

const {
  acquisitionTrackingEnabled,
  captureCheckoutStarted,
  captureSignupSource,
  documentAcquisitionSource,
  rememberOAuthSource,
  withSignupSource
} = await import('../../../server/utils/analytics/acquisitionSource')
const { asUser } = await import('../../helpers/access')

const SITE = '0d2c6a3e-1b4f-4a8e-9c0d-123456789abc'
const PROVIDER_REDIRECT = 'https://github.com/login/oauth/authorize?client_id=x&state=st-123'

describe('acquisition source capture', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.clear()
    stubEnv({ NUXT_PUBLIC_ANALYTICS_WEBSITE_ID: SITE })
  })

  it('is on only where the statistics are', () => {
    expect(acquisitionTrackingEnabled()).toBe(true)
    stubEnv({ NUXT_PUBLIC_ANALYTICS_WEBSITE_ID: undefined })
    expect(acquisitionTrackingEnabled()).toBe(false)
  })

  it('documents: the sent source for anonymous creators, the account\'s for signed-in ones', async () => {
    const plain = fake({ headers: {}, query: {} })
    expect(await documentAcquisitionSource(plain, 'hackernews', null)).toBe('hackernews')
    expect(await documentAcquisitionSource(plain, 'https://evil.example', null)).toBeNull()
    const self = asUser(7)
    expect(await documentAcquisitionSource(plain, 'hackernews', self)).toBe('producthunt')
    expect(repo.getAccountAcquisitionSource).toHaveBeenCalledWith(self)
    repo.getAccountAcquisitionSource.mockRejectedValueOnce(new Error('db down'))
    expect(await documentAcquisitionSource(plain, 'hackernews', self)).toBeNull()
  })

  it('documents: nothing with GPC, DNT or the statistics off', async () => {
    expect(await documentAcquisitionSource(fake({ headers: { 'sec-gpc': '1' }, query: {} }), 'github', null)).toBeNull()
    expect(await documentAcquisitionSource(fake({ headers: { dnt: '1' }, query: {} }), 'github', null)).toBeNull()
    stubEnv({ NUXT_PUBLIC_ANALYTICS_WEBSITE_ID: undefined })
    expect(await documentAcquisitionSource(fake({ headers: {}, query: {} }), 'github', null)).toBeNull()
  })

  it('a sign-in link\'s source waits under the OAuth state and becomes the new account\'s', async () => {
    await rememberOAuthSource(fake({ headers: {}, query: { ref: 'producthunt' }, location: PROVIDER_REDIRECT }))
    expect(valkey.set).toHaveBeenCalledTimes(1)
    const [key, value, , ttl] = valkey.set.mock.calls[0] as unknown as [string, string, string, number]
    // The state is hashed, never stored as is.
    expect(key).not.toContain('st-123')
    expect(value).toBe('producthunt')
    expect(ttl).toBe(900)

    const callback = fake({ headers: {}, query: { state: 'st-123', code: 'c' } })
    expect(await captureSignupSource(callback, 42)).toBe('producthunt')
    expect(repo.recordAccountAcquisitionSource).toHaveBeenCalledTimes(1)
    expect((repo.recordAccountAcquisitionSource.mock.calls[0] as unknown as [{ userId: number }, string])[0].userId).toBe(42)
    // Taken once.
    expect(await captureSignupSource(callback, 42)).toBeNull()
  })

  it('parks nothing for an unknown label, GPC, a missing state or the statistics off', async () => {
    await rememberOAuthSource(fake({ headers: {}, query: { ref: 'someone@example.com' }, location: PROVIDER_REDIRECT }))
    await rememberOAuthSource(fake({ headers: { 'sec-gpc': '1' }, query: { ref: 'github' }, location: PROVIDER_REDIRECT }))
    await rememberOAuthSource(fake({ headers: {}, query: { ref: 'github' } }))
    await rememberOAuthSource(fake({ headers: {}, query: { ref: 'github' }, location: 'https://github.com/login' }))
    stubEnv({ NUXT_PUBLIC_ANALYTICS_WEBSITE_ID: undefined })
    await rememberOAuthSource(fake({ headers: {}, query: { ref: 'github' }, location: PROVIDER_REDIRECT }))
    expect(valkey.set).not.toHaveBeenCalled()
    expect(await captureSignupSource(fake({ headers: {}, query: { state: 'st-123' } }), 1)).toBeNull()
  })

  it('the callback without a state, or with Valkey down, stores nothing and never throws', async () => {
    expect(await captureSignupSource(fake({ headers: {}, query: {} }), 1)).toBeNull()
    valkey.getdel.mockRejectedValueOnce(new Error('valkey down'))
    expect(await captureSignupSource(fake({ headers: {}, query: { state: 's' } }), 1)).toBeNull()
    valkey.set.mockRejectedValueOnce(new Error('valkey down'))
    await expect(rememberOAuthSource(fake({ headers: {}, query: { ref: 'github' }, location: PROVIDER_REDIRECT }))).resolves.toBeUndefined()
    expect(repo.recordAccountAcquisitionSource).not.toHaveBeenCalled()
  })

  it('the landing path names the stored source for the sign-up event', () => {
    expect(withSignupSource('/?signed_up=github', 'producthunt')).toBe('/?signed_up=github&signed_up_source=producthunt')
    expect(withSignupSource('/pricing', null)).toBe('/pricing')
  })

  it('marks the first checkout, never failing the purchase', async () => {
    const self = asUser(9)
    await captureCheckoutStarted(fake({ headers: {}, query: {} }), self)
    expect(repo.recordCheckoutStarted).toHaveBeenCalledWith(self)
    await captureCheckoutStarted(fake({ headers: { dnt: '1' }, query: {} }), self)
    expect(repo.recordCheckoutStarted).toHaveBeenCalledTimes(1)
    repo.recordCheckoutStarted.mockRejectedValueOnce(new Error('db down'))
    await expect(captureCheckoutStarted(fake({ headers: {}, query: {} }), self)).resolves.toBeUndefined()
  })
})
