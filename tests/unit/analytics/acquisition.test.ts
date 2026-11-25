import { describe, expect, it, vi } from 'vitest'
import { getTableColumns } from 'drizzle-orm'
import {
  ACQUISITION_SOURCES,
  FUNNEL_SOURCES,
  acquisitionSourceBody,
  acquisitionSourceOf,
  funnelSourceOf,
  parseAcquisitionSource,
  sourceFromLabel,
  sourceFromReferrer,
  sourceFromReferrerHost
} from '../../../shared/analytics/acquisition'
import { createAnalyticsClient, type AnalyticsEnv } from '../../../app/utils/analytics/analyticsClient'
import { ANALYTICS_EVENTS, SOURCE_TAGGED_EVENTS } from '../../../shared/analytics/events'
import { documents, users } from '../../../server/db/schema'
import { createDocBody } from '../../../shared/api/docs'

// The acquisition source (shared/analytics/acquisition.ts): free-form
// labels and referrers fold into a fixed list, nothing else ever leaves
// the browser or reaches a row.

describe('acquisition source normalisation', () => {
  it('maps known labels and aliases, anything else is other', () => {
    expect(sourceFromLabel('producthunt')).toBe('producthunt')
    expect(sourceFromLabel(' Product-Hunt ')).toBe('producthunt')
    expect(sourceFromLabel('PH')).toBe('producthunt')
    expect(sourceFromLabel('https://www.producthunt.com')).toBe('producthunt')
    expect(sourceFromLabel('hn')).toBe('hackernews')
    expect(sourceFromLabel('news.ycombinator.com')).toBe('hackernews')
    expect(sourceFromLabel('Google')).toBe('google')
    expect(sourceFromLabel('github')).toBe('github')
    expect(sourceFromLabel('newsletter-2027')).toBe('other')
    expect(sourceFromLabel(['producthunt', 'google'])).toBe('producthunt')
  })

  it('empty, symbol-only or over-long labels are no source', () => {
    expect(sourceFromLabel('')).toBeNull()
    expect(sourceFromLabel('   ')).toBeNull()
    expect(sourceFromLabel('---')).toBeNull()
    expect(sourceFromLabel(undefined)).toBeNull()
    expect(sourceFromLabel(42)).toBeNull()
    expect(sourceFromLabel('x'.repeat(101))).toBeNull()
  })

  it('classifies referring hosts; this site itself is no source', () => {
    expect(sourceFromReferrerHost('www.producthunt.com', 'markoto.app')).toBe('producthunt')
    expect(sourceFromReferrerHost('news.ycombinator.com', 'markoto.app')).toBe('hackernews')
    expect(sourceFromReferrerHost('github.com', 'markoto.app')).toBe('github')
    expect(sourceFromReferrerHost('www.google.co.uk', 'markoto.app')).toBe('google')
    expect(sourceFromReferrerHost('google.de.', 'markoto.app')).toBe('google')
    expect(sourceFromReferrerHost('googleusercontent.example', 'markoto.app')).toBe('other')
    expect(sourceFromReferrerHost('fakeproducthunt.com', 'markoto.app')).toBe('other')
    expect(sourceFromReferrerHost('markoto.app', 'markoto.app')).toBeNull()
    expect(sourceFromReferrerHost('', 'markoto.app')).toBeNull()
    expect(sourceFromReferrerHost(null, 'markoto.app')).toBeNull()
  })

  it('reads referrer URLs, ignoring non-web and malformed ones', () => {
    expect(sourceFromReferrer('https://www.producthunt.com/posts/markoto', 'markoto.app')).toBe('producthunt')
    expect(sourceFromReferrer('android-app://com.google.android.gm', 'markoto.app')).toBeNull()
    expect(sourceFromReferrer('not a url', 'markoto.app')).toBeNull()
    expect(sourceFromReferrer('', 'markoto.app')).toBeNull()
  })

  it('prefers ref, then utm_source, then the referrer (URL or bare domain)', () => {
    const own = 'markoto.app'
    expect(acquisitionSourceOf({ query: { ref: 'producthunt', utm_source: 'google' }, referrer: 'https://github.com/', ownHost: own })).toBe('producthunt')
    expect(acquisitionSourceOf({ query: { utm_source: 'hn' }, referrer: 'https://github.com/', ownHost: own })).toBe('hackernews')
    expect(acquisitionSourceOf({ query: {}, referrer: 'https://github.com/', ownHost: own })).toBe('github')
    expect(acquisitionSourceOf({ query: {}, referrer: 'news.ycombinator.com', ownHost: own })).toBe('hackernews')
    expect(acquisitionSourceOf({ query: {}, referrer: '', ownHost: own })).toBeNull()
  })

  it('accepts stored or sent values only when they are exactly a category', () => {
    for (const s of ACQUISITION_SOURCES) expect(parseAcquisitionSource(s)).toBe(s)
    expect(parseAcquisitionSource('direct')).toBeNull()
    expect(parseAcquisitionSource('ProductHunt')).toBeNull()
    expect(parseAcquisitionSource(null)).toBeNull()
    expect(funnelSourceOf(null)).toBe('direct')
    expect(funnelSourceOf('bogus')).toBe('direct')
    expect(funnelSourceOf('github')).toBe('github')
    expect(FUNNEL_SOURCES).toEqual([...ACQUISITION_SOURCES, 'direct'])
  })

  it('the request body drops anything outside the list instead of failing', () => {
    expect(acquisitionSourceBody.parse('producthunt')).toBe('producthunt')
    expect(acquisitionSourceBody.parse('https://evil.example/?email=a@b.c')).toBeNull()
    expect(createDocBody.parse({ acquisitionSource: 'someone@example.com' })?.acquisitionSource).toBeNull()
    expect(createDocBody.parse({ acquisitionSource: 'hackernews' })?.acquisitionSource).toBe('hackernews')
  })

  it('the database columns allow exactly the list', () => {
    expect(getTableColumns(users).acquisitionSource.enumValues).toEqual([...ACQUISITION_SOURCES])
    expect(getTableColumns(documents).acquisitionSource.enumValues).toEqual([...ACQUISITION_SOURCES])
  })
})

describe('acquisition source in the analytics client', () => {
  const config = { websiteId: '0d2c6a3e-1b4f-4a8e-9c0d-123456789abc', endpoint: '/a/api/send', adsConversions: false }
  const ok = () => vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch & ReturnType<typeof vi.fn>
  const env = (fetchFn: typeof fetch, search: string, referrer = ''): AnalyticsEnv => ({
    fetch: fetchFn,
    location: { hostname: 'markoto.app', search },
    language: 'en',
    screen: '390x844',
    title: () => 'markoto',
    referrer
  })
  const bodies = (f: ReturnType<typeof vi.fn>) => f.mock.calls.map(c => String((c as [string, RequestInit])[1].body))
  const tick = () => new Promise(r => setTimeout(r, 0))

  it('tags funnel events and page views with the category only', async () => {
    const f = ok()
    const c = createAnalyticsClient(config, env(f, '?ref=producthunt'), false)
    expect(c.source()).toBe('producthunt')
    c.pageview('/')
    c.track(ANALYTICS_EVENTS.docCreated, { anonymous: true, source: 'dialog' }, '/d/abc')
    c.trackResolved({ name: ANALYTICS_EVENTS.checkoutStarted, data: { plan: 'pro' } }, '/pricing')
    c.track(ANALYTICS_EVENTS.githubClicked, { placement: 'header' }, '/')
    await tick()
    const sent = bodies(f).map(b => JSON.parse(b) as { payload: { url: string, data?: Record<string, unknown> } })
    expect(sent[0]!.payload.url).toBe('/?ref=producthunt')
    expect(sent[1]!.payload.data).toEqual({ anonymous: true, source: 'dialog', ref: 'producthunt' })
    expect(sent[2]!.payload.data).toEqual({ plan: 'pro', ref: 'producthunt' })
    // Not a funnel step: no source.
    expect(sent[3]!.payload.data).toEqual({ placement: 'header' })
  })

  it('a direct visit tags funnel events as direct; a signed-in visitor\'s referrer is ignored', async () => {
    const f = ok()
    const c = createAnalyticsClient({ ...config, signedIn: true }, env(f, '', 'https://github.com/'), false)
    expect(c.source()).toBeNull()
    c.track(ANALYTICS_EVENTS.signupCompleted, { provider: 'github' }, '/')
    c.setSource('github')
    c.track(ANALYTICS_EVENTS.checkoutCompleted, { kind: 'personal' }, '/pricing')
    await tick()
    const data = bodies(f).map(b => (JSON.parse(b) as { payload: { data?: Record<string, unknown> } }).payload.data)
    expect(data[0]).toEqual({ provider: 'github', ref: 'direct' })
    expect(data[1]).toEqual({ kind: 'personal', ref: 'github' })
    expect(createAnalyticsClient(config, env(ok(), '', 'https://github.com/'), false).source()).toBe('github')
  })

  it('no personal data or raw URL reaches the statistics, whatever the landing URL holds', async () => {
    const f = ok()
    const search = '?ref=' + encodeURIComponent('https://evil.example/?email=jane.doe@example.com&name=Jane')
    const c = createAnalyticsClient(config, env(f, search, 'https://mail.example.com/inbox?u=jane.doe@example.com'), false)
    expect(c.source()).toBe('other')
    c.pageview('/')
    for (const name of SOURCE_TAGGED_EVENTS) c.trackResolved({ name }, '/')
    await tick()
    const all = bodies(f).join('\n')
    expect(bodies(f)).toHaveLength(1 + SOURCE_TAGGED_EVENTS.size)
    // The referring site goes as its origin only (pages.ts referrerOrigin), never its path or query.
    expect(all).not.toMatch(/@|jane|evil|inbox/i)
    const payloads = bodies(f).map(b => (JSON.parse(b) as { payload: { url: string, data?: Record<string, unknown> } }).payload)
    // Every URL carries the category as `ref`, every funnel event as its `ref` property: nothing else.
    expect(payloads.map(p => p.url)).toEqual(payloads.map(() => '/?ref=other'))
    expect(payloads.slice(1).map(p => p.data)).toEqual(payloads.slice(1).map(() => ({ ref: 'other' })))
    expect(FUNNEL_SOURCES).toContain('other')
  })

  it('statistics off or opted out: no source kept', () => {
    expect(createAnalyticsClient({ ...config, websiteId: '' }, env(ok(), '?ref=producthunt'), false).source()).toBeNull()
    const opted = createAnalyticsClient(config, env(ok(), '?ref=producthunt'), true)
    opted.setSource('github')
    expect(opted.source()).toBeNull()
  })
})
