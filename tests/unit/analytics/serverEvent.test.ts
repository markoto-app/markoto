import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'
import { stubEnv } from '../../helpers/env'
import { deliberatelyInvalid } from '../../helpers/fixtures'
import { countPublishedPageView } from '../../../server/utils/analytics/serverEvent'
import { currentRegistryFlags } from '../../../server/utils/privacy/registryFlags'

const headers = new Map<string, string>()
vi.stubGlobal('getRequestHeader', (_e: unknown, name: string) => headers.get(name))
// Only forwarded to getRequestHeader (stubbed above).
const event: H3Event = deliberatelyInvalid({})
const ID = '0d2c6a3e-1b4f-4a8e-9c0d-123456789abc'
const realFetch = globalThis.fetch

describe('published-page view count', () => {
  const fetchMock = vi.fn(async () => new Response('{}'))
  beforeEach(() => {
    headers.clear()
    fetchMock.mockClear()
    vi.stubGlobal('fetch', fetchMock)
    stubEnv({ NUXT_PUBLIC_ANALYTICS_WEBSITE_ID: ID, NUXT_ANALYTICS_INTERNAL_URL: 'http://umami:3000', NUXT_SITE_URL: 'https://markoto.app' })
  })
  afterEach(() => {
    vi.stubGlobal('fetch', realFetch)
  })

  it('posts one aggregate event to Umami in the network', () => {
    headers.set('user-agent', 'Mozilla/5.0 (Macintosh) Safari/605.1.15')
    countPublishedPageView(event)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(String(url)).toBe('http://umami:3000/api/send')
    const body = JSON.parse(String(init.body)) as { payload: Record<string, unknown> }
    expect(body.payload).toMatchObject({ website: ID, hostname: 'markoto.app', url: '/p', name: 'published_page_view', ip: '127.0.0.1' })
    // The visitor's user agent is not forwarded.
    expect((init.headers as Record<string, string>)['user-agent']).toContain('markoto-server')
  })

  it('skips bots, and does nothing without analytics or an internal URL', () => {
    headers.set('user-agent', 'Googlebot/2.1')
    countPublishedPageView(event)
    headers.set('user-agent', 'Mozilla/5.0')
    stubEnv({ NUXT_ANALYTICS_INTERNAL_URL: undefined })
    countPublishedPageView(event)
    stubEnv({ NUXT_ANALYTICS_INTERNAL_URL: 'http://umami:3000', NUXT_PUBLIC_ANALYTICS_WEBSITE_ID: undefined })
    countPublishedPageView(event)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('registry flags', () => {
  it('follow the deployment', () => {
    stubEnv({ NUXT_BILLING_ENABLED: 'false', NUXT_PUBLIC_ANALYTICS_WEBSITE_ID: ID, NUXT_PUBLIC_ANALYTICS_ADS_CONVERSIONS: 'true' })
    expect(currentRegistryFlags()).toEqual({ billing: false, analytics: true, adsConversions: true })
    stubEnv({ NUXT_PUBLIC_ANALYTICS_WEBSITE_ID: undefined, NUXT_PUBLIC_ANALYTICS_ADS_CONVERSIONS: undefined })
    expect(currentRegistryFlags()).toEqual({ billing: false, analytics: false, adsConversions: false })
  })
})
