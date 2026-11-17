import { describe, expect, it } from 'vitest'
import { buildClickConversions, googleAdsDateTime } from '../../../server/utils/analytics/googleAdsUpload'
import { publishedPageViewBody } from '../../../server/utils/analytics/serverEvent'

describe('Google Ads click conversions', () => {
  it('formats the conversion time as Google expects (UTC offset)', () => {
    expect(googleAdsDateTime(new Date('2026-11-17T08:05:09.123Z'))).toBe('2026-11-17 08:05:09+00:00')
  })

  it('one row per conversion with a configured action, keyed by the click id type', () => {
    const rows = buildClickConversions([
      { id: 1, clickIdType: 'gclid', clickId: 'Cj0KCQiA-abc', conversion: 'signup', convertedAt: new Date('2026-11-17T10:00:00Z') },
      { id: 2, clickIdType: 'wbraid', clickId: 'CjkKCQiA-xyz', conversion: 'first_document', convertedAt: new Date('2026-11-17T11:00:00Z') },
      { id: 3, clickIdType: 'gclid', clickId: 'Cj0KCQiA-def', conversion: 'waitlist_signup', convertedAt: new Date('2026-11-17T12:00:00Z') }
    ], {
      signup: 'customers/123/conversionActions/1',
      first_document: 'customers/123/conversionActions/2'
    })
    expect(rows).toEqual([
      { gclid: 'Cj0KCQiA-abc', conversionAction: 'customers/123/conversionActions/1', conversionDateTime: '2026-11-17 10:00:00+00:00', consent: { adUserData: 'DENIED' } },
      { wbraid: 'CjkKCQiA-xyz', conversionAction: 'customers/123/conversionActions/2', conversionDateTime: '2026-11-17 11:00:00+00:00', consent: { adUserData: 'DENIED' } }
    ])
    // Nothing but the click id, the action, the time and the consent state.
    for (const r of rows) expect(Object.keys(r).sort()).toHaveLength(4)
  })
})

describe('published-page view count', () => {
  it('carries no slug and no visitor data', () => {
    const body = publishedPageViewBody('0d2c6a3e-1b4f-4a8e-9c0d-123456789abc', 'markoto.app')
    expect(body.payload.url).toBe('/p')
    expect(body.payload.name).toBe('published_page_view')
    expect(body.payload.ip).toBe('127.0.0.1')
    expect(Object.keys(body.payload)).not.toContain('referrer')
    expect(Object.keys(body.payload)).not.toContain('title')
  })
})
