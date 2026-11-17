import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'
import { stubEnv } from '../../helpers/env'

// Server side of the click-id capture (server/utils/analytics/adConversions.ts):
// the flag, GPC / DNT, and the OAuth hand-over through Valkey. The repos
// and Valkey are faked; the DB side is covered by tests/repos/adConversions.test.ts.

const repo = vi.hoisted(() => ({
  recordAdConversion: vi.fn(async () => true),
  recordWaitlistAdConversion: vi.fn(async () => true),
  recordFirstDocumentFromSignupClick: vi.fn(async () => true)
}))
vi.mock('../../../server/repos/adConversions', () => repo)

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
  captureDocumentConversion,
  captureOAuthSignup,
  captureWaitlistConversion,
  rememberOAuthClick
} = await import('../../../server/utils/analytics/adConversions')
const { system } = await import('../../../server/repos/proofs')
const { asUser } = await import('../../helpers/access')

const CLICK = { type: 'gclid' as const, value: 'Cj0KCQiA-unit-click' }

describe('click-id capture', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.clear()
    stubEnv({ NUXT_PUBLIC_ANALYTICS_ADS_CONVERSIONS: 'true' })
  })

  it('records a waitlist conversion; not with the flag off, GPC, DNT or no click', async () => {
    await captureWaitlistConversion(fake({ headers: {}, query: {} }), CLICK, 'a@example.com')
    expect(repo.recordWaitlistAdConversion).toHaveBeenCalledWith(system('ad-conversions'), CLICK, 'a@example.com')
    await captureWaitlistConversion(fake({ headers: { 'sec-gpc': '1' }, query: {} }), CLICK, 'a@example.com')
    await captureWaitlistConversion(fake({ headers: { dnt: '1' }, query: {} }), CLICK, 'a@example.com')
    await captureWaitlistConversion(fake({ headers: {}, query: {} }), null, 'a@example.com')
    stubEnv({ NUXT_PUBLIC_ANALYTICS_ADS_CONVERSIONS: 'false' })
    await captureWaitlistConversion(fake({ headers: {}, query: {} }), CLICK, 'a@example.com')
    expect(repo.recordWaitlistAdConversion).toHaveBeenCalledTimes(1)
  })

  it('documents: the body click converts; without one a signed-in account reuses its sign-up click', async () => {
    await captureDocumentConversion(fake({ headers: {}, query: {} }), CLICK, null)
    expect(repo.recordAdConversion).toHaveBeenCalledWith(system('ad-conversions'), { clickId: CLICK, conversion: 'first_document', userId: null })
    const self = asUser(7)
    await captureDocumentConversion(fake({ headers: {}, query: {} }), undefined, self)
    expect(repo.recordFirstDocumentFromSignupClick).toHaveBeenCalledWith(self)
    await captureDocumentConversion(fake({ headers: {}, query: {} }), undefined, null)
    await captureDocumentConversion(fake({ headers: { 'sec-gpc': '1' }, query: {} }), CLICK, self)
    expect(repo.recordAdConversion).toHaveBeenCalledTimes(1)
    expect(repo.recordFirstDocumentFromSignupClick).toHaveBeenCalledTimes(1)
  })

  it('a failing write is swallowed: the user\'s request never fails over it', async () => {
    repo.recordAdConversion.mockRejectedValueOnce(new Error('db down'))
    await expect(captureDocumentConversion(fake({ headers: {}, query: {} }), CLICK, null)).resolves.toBeUndefined()
  })

  it('OAuth: the start leg parks the click under the state, the callback of a new account turns it into a sign-up', async () => {
    const start = fake({ headers: {}, query: { gclid: CLICK.value }, location: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=STATE123' })
    await rememberOAuthClick(start)
    expect(valkey.set).toHaveBeenCalledWith(expect.stringMatching(/^ads:oauth-click:[0-9a-f]{64}$/), JSON.stringify(CLICK), 'EX', 900)
    // The raw state is not the key.
    expect([...store.keys()][0]).not.toContain('STATE123')

    await captureOAuthSignup(fake({ headers: {}, query: { state: 'STATE123', code: 'c' } }), 42)
    expect(repo.recordAdConversion).toHaveBeenCalledWith(system('ad-conversions'), { clickId: CLICK, conversion: 'signup', userId: 42 })
    // Single use.
    await captureOAuthSignup(fake({ headers: {}, query: { state: 'STATE123', code: 'c' } }), 42)
    expect(repo.recordAdConversion).toHaveBeenCalledTimes(1)
  })

  it('OAuth: nothing is parked without a click, without a state, on the callback redirect, or with GPC', async () => {
    await rememberOAuthClick(fake({ headers: {}, query: {}, location: 'https://idp/auth?state=S' }))
    await rememberOAuthClick(fake({ headers: {}, query: { gclid: CLICK.value }, location: 'https://idp/auth' }))
    await rememberOAuthClick(fake({ headers: {}, query: { gclid: CLICK.value }, location: '/?signed_up=google' }))
    await rememberOAuthClick(fake({ headers: { 'sec-gpc': '1' }, query: { gclid: CLICK.value }, location: 'https://idp/auth?state=S' }))
    await rememberOAuthClick(fake({ headers: {}, query: { gclid: CLICK.value } }))
    expect(valkey.set).not.toHaveBeenCalled()
    await captureOAuthSignup(fake({ headers: {}, query: {} }), 1)
    stubEnv({ NUXT_PUBLIC_ANALYTICS_ADS_CONVERSIONS: 'false' })
    await captureOAuthSignup(fake({ headers: {}, query: { state: 'S' } }), 1)
    expect(valkey.getdel).not.toHaveBeenCalled()
  })
})
