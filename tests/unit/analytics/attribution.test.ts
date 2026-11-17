import { describe, expect, it } from 'vitest'
import {
  attributionFromQuery,
  cleanUtmValue,
  clickIdBody,
  clickIdFromQuery,
  clickIdQuery,
  searchToQuery
} from '../../../shared/analytics/attribution'

const GCLID = 'Cj0KCQiA4NWrBhD-ARIsAFCKwWt_abc123'

describe('click ids', () => {
  it('reads gclid, gbraid and wbraid, preferring gclid', () => {
    expect(clickIdFromQuery({ gclid: GCLID })).toEqual({ type: 'gclid', value: GCLID })
    expect(clickIdFromQuery({ gbraid: '0AAAAAoAbC123', wbraid: 'CjkKCQiA12345' })).toEqual({ type: 'gbraid', value: '0AAAAAoAbC123' })
    expect(clickIdFromQuery({ wbraid: 'CjkKCQiA12345', gclid: GCLID })?.type).toBe('gclid')
  })

  it('ignores malformed ids: too short, too long, foreign characters, arrays use the first', () => {
    expect(clickIdFromQuery({ gclid: 'short' })).toBeNull()
    expect(clickIdFromQuery({ gclid: 'x'.repeat(513) })).toBeNull()
    expect(clickIdFromQuery({ gclid: 'abc<script>alert(1)</script>' })).toBeNull()
    expect(clickIdFromQuery({ gclid: 'has space in it' })).toBeNull()
    expect(clickIdFromQuery({ gclid: [GCLID, 'other'] })).toEqual({ type: 'gclid', value: GCLID })
    expect(clickIdFromQuery({})).toBeNull()
  })

  it('the request-body schema drops anything malformed instead of failing the request', () => {
    expect(clickIdBody.parse({ type: 'gclid', value: GCLID })).toEqual({ type: 'gclid', value: GCLID })
    expect(clickIdBody.parse({ type: 'fbclid', value: GCLID })).toBeNull()
    expect(clickIdBody.parse({ type: 'gclid', value: 'x' })).toBeNull()
    expect(clickIdBody.parse('nonsense')).toBeNull()
    expect(clickIdBody.parse(null)).toBeNull()
    expect(clickIdBody.parse(undefined)).toBeUndefined()
  })

  it('becomes the sign-in link query', () => {
    expect(clickIdQuery({ type: 'wbraid', value: 'CjkKCQiA12345' })).toEqual({ wbraid: 'CjkKCQiA12345' })
    expect(clickIdQuery(null)).toEqual({})
  })
})

describe('utm parameters', () => {
  it('keeps plain campaign labels', () => {
    const q = searchToQuery('?utm_source=google&utm_medium=cpc&utm_campaign=Launch+CH+2026&utm_term=markdown%20editor&utm_content=ad_a&x=1')
    expect(attributionFromQuery(q).utm).toEqual({
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'Launch CH 2026',
      utm_term: 'markdown editor',
      utm_content: 'ad_a'
    })
  })

  it('drops values that are long, markup or spreadsheet formulas', () => {
    expect(cleanUtmValue('x'.repeat(101))).toBeNull()
    expect(cleanUtmValue('<b>x</b>')).toBeNull()
    expect(cleanUtmValue('=HYPERLINK("x")')).toBeNull()
    expect(cleanUtmValue('-1+1')).toBeNull()
    expect(cleanUtmValue('')).toBeNull()
    expect(cleanUtmValue('Zürich, Sommer')).toBe('Zürich, Sommer')
  })

  it('searchToQuery keeps the first of repeated keys', () => {
    expect(searchToQuery('?gclid=a&gclid=b')).toEqual({ gclid: 'a' })
  })
})
