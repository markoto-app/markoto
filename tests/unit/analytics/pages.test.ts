import { describe, expect, it, vi } from 'vitest'
import {
  APP_PATH,
  buildCollectPayload,
  optedOutByHeaders,
  optedOutOfTracking,
  referrerOrigin,
  trackablePath,
  type CollectContext
} from '../../../shared/analytics/pages'
import { createAnalyticsClient, type AnalyticsEnv } from '../../../app/utils/analytics/analyticsClient'

const ctx = (over: Partial<CollectContext> = {}): CollectContext => ({
  websiteId: '0d2c6a3e-1b4f-4a8e-9c0d-123456789abc',
  hostname: 'markoto.app',
  language: 'de-CH',
  screen: '1440x900',
  path: '/pricing',
  title: 'Pricing · markoto',
  referrer: 'https://www.google.com/search?q=secret+query',
  utm: { utm_source: 'google', utm_medium: 'cpc' },
  ...over
})

describe('trackablePath', () => {
  it('counts the public pages', () => {
    for (const p of ['/', '/pricing', '/docs/self-hosting', '/legal/privacy', '/de/eu-markdown-editor', '/compare/notion', '/waitlist/confirm']) {
      expect(trackablePath(p)).toBe(p)
    }
    expect(trackablePath('/pricing/')).toBe('/pricing')
    expect(trackablePath('/pricing?token=abc#x')).toBe('/pricing')
  })

  it('never counts documents, published pages or app / token pages', () => {
    for (const p of ['/d/abc123', '/d', '/p/my-private-slug', '/w/5', '/settings/ai', '/admin/abuse-reports', '/auth/sso-error', '/_internal/render/x', '/invites/accept', '/waitlist/unsubscribe', '/docs/_internal/flows', '/api/x']) {
      expect(trackablePath(p)).toBeNull()
    }
    expect(trackablePath('relative')).toBeNull()
  })
})

describe('buildCollectPayload', () => {
  it('a page view: path + UTM only, the referrer reduced to its origin', () => {
    const body = buildCollectPayload(ctx())
    expect(body.payload.url).toBe('/pricing?utm_source=google&utm_medium=cpc')
    expect(body.payload.referrer).toBe('https://www.google.com/')
    expect(body.payload.title).toBe('Pricing · markoto')
    expect(body.payload.name).toBeUndefined()
  })

  it('an event inside the editor carries neither the document id nor its title', () => {
    const body = buildCollectPayload(ctx({ path: '/d/abc123', title: 'Salary review 2027' }), { name: 'doc_created', data: { anonymous: false, source: 'dialog' } })
    const json = JSON.stringify(body)
    expect(body.payload.url.startsWith(APP_PATH)).toBe(true)
    expect(json).not.toContain('abc123')
    expect(json).not.toContain('Salary')
    expect(body.payload.referrer).toBeUndefined()
    expect(body.payload.name).toBe('doc_created')
  })

  it('self-referrals and non-http referrers are dropped', () => {
    expect(referrerOrigin('https://markoto.app/pricing', 'markoto.app')).toBeUndefined()
    expect(referrerOrigin('android-app://com.google', 'markoto.app')).toBeUndefined()
    expect(referrerOrigin('', 'markoto.app')).toBeUndefined()
  })
})

describe('opt-out signals', () => {
  it('Global Privacy Control and Do Not Track', () => {
    expect(optedOutOfTracking({ globalPrivacyControl: true })).toBe(true)
    expect(optedOutOfTracking({ doNotTrack: '1' })).toBe(true)
    expect(optedOutOfTracking({}, { doNotTrack: '1' })).toBe(true)
    expect(optedOutOfTracking({ doNotTrack: 'unspecified', globalPrivacyControl: false })).toBe(false)
    expect(optedOutByHeaders(n => (n === 'sec-gpc' ? '1' : null))).toBe(true)
    expect(optedOutByHeaders(n => (n === 'dnt' ? '1' : null))).toBe(true)
    expect(optedOutByHeaders(() => null)).toBe(false)
  })
})

describe('analytics client', () => {
  const env = (fetchFn: typeof fetch, search = '?gclid=Cj0KCQiA4NWrBhD-ARIsAF&utm_source=google'): AnalyticsEnv => ({
    fetch: fetchFn,
    location: { hostname: 'markoto.app', search },
    language: 'en',
    screen: '390x844',
    title: () => 'markoto',
    referrer: ''
  })
  const ok = () => vi.fn(async () => new Response(JSON.stringify({ cache: 'tok' }), { status: 200 })) as unknown as typeof fetch & ReturnType<typeof vi.fn>
  const config = { websiteId: '0d2c6a3e-1b4f-4a8e-9c0d-123456789abc', endpoint: '/a/api/send', adsConversions: true }

  it('posts same-origin page views once per path, never for documents', async () => {
    const f = ok()
    const c = createAnalyticsClient(config, env(f), false)
    c.pageview('/')
    c.pageview('/')
    c.pageview('/d/xyz')
    await new Promise(r => setTimeout(r, 0))
    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = f.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/a/api/send')
    expect(init.credentials).toBe('omit')
    const body = JSON.parse(String(init.body)) as { payload: { url: string } }
    // The click id is not sent to analytics, only the UTM parameters.
    expect(body.payload.url).toBe('/?utm_source=google')
  })

  it('keeps the click id in memory for conversions, only when conversions are on', () => {
    expect(createAnalyticsClient(config, env(ok()), false).clickId()).toEqual({ type: 'gclid', value: 'Cj0KCQiA4NWrBhD-ARIsAF' })
    expect(createAnalyticsClient({ ...config, adsConversions: false }, env(ok()), false).clickId()).toBeNull()
  })

  it('an opted-out visitor sends nothing and keeps no click id', async () => {
    const f = ok()
    const c = createAnalyticsClient(config, env(f), true)
    c.pageview('/')
    c.track('signup_started', { provider: 'google' }, '/')
    await new Promise(r => setTimeout(r, 0))
    expect(f).not.toHaveBeenCalled()
    expect(c.clickId()).toBeNull()
  })

  it('without a website id nothing is sent, but conversions still get the click id', async () => {
    const f = ok()
    const c = createAnalyticsClient({ ...config, websiteId: '' }, env(f), false)
    c.pageview('/')
    await new Promise(r => setTimeout(r, 0))
    expect(f).not.toHaveBeenCalled()
    expect(c.clickId()?.type).toBe('gclid')
  })

  it('reuses Umami\'s session token on the next request', async () => {
    const f = ok()
    const c = createAnalyticsClient(config, env(f), false)
    c.pageview('/')
    await new Promise(r => setTimeout(r, 0))
    c.pageview('/pricing')
    await new Promise(r => setTimeout(r, 0))
    const headers = (f.mock.calls[1] as [string, RequestInit])[1].headers as Record<string, string>
    expect(headers['x-umami-cache']).toBe('tok')
  })
})
