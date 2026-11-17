import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  cumulativeSeries, pivotStatsSeries, retentionAlpha, statsBucketLabel, statsBytes, statsChange, statsCount, statsMoney, statsPercent
} from '../../app/utils/admin/statsFormat'
import { csvCell, csvFileName, downloadCsv, toCsv } from '../../app/utils/admin/csv'

// Formatting, chart shaping and CSV export of the admin's product stats.

describe('stats formatting', () => {
  it('formats counts, percentages, money and bytes per locale', () => {
    expect(statsCount(12345, 'en')).toBe('12,345')
    expect(statsPercent(33.33, 'en')).toBe('33.3 %')
    expect(statsMoney(37.5, 'chf', 'en').replaceAll(/\s/g, ' ')).toBe('CHF 37.50')
    expect(statsBytes(999, 'en')).toBe('999 B')
    expect(statsBytes(10_300, 'en')).toBe('10 KB')
    expect(statsBytes(2_500_000, 'en')).toBe('2.5 MB')
    expect(statsBytes(4e15, 'en')).toBe('4,000 TB')
  })

  it('shows the change with a direction, or nothing to compare', () => {
    expect(statsChange({ value: 15, previous: 10 }, 'en')).toEqual({ text: '+50 %', direction: 'up' })
    expect(statsChange({ value: 5, previous: 10 }, 'en')).toEqual({ text: '-50 %', direction: 'down' })
    expect(statsChange({ value: 10, previous: 10 }, 'en')).toEqual({ text: '0 %', direction: 'flat' })
    expect(statsChange({ value: 1, previous: null }, 'en')).toBeNull()
  })

  it('labels buckets by day or by month', () => {
    expect(statsBucketLabel('2026-11-16', 'day', 'en')).toBe('Nov 16')
    expect(statsBucketLabel('2026-11-01', 'month', 'en')).toBe('Nov 2026')
  })

  it('builds running totals that end at today\'s total', () => {
    const pts = [{ t: 'a', v: 1 }, { t: 'b', v: 2 }]
    expect(cumulativeSeries(pts).map(p => p.v)).toEqual([1, 3])
    expect(cumulativeSeries(pts, 10).map(p => p.v)).toEqual([8, 10])
  })

  it('pivots long rows into one dataset per key, largest first', () => {
    const out = pivotStatsSeries([
      { t: '2026-11-02', key: 'b', v: 1 },
      { t: '2026-11-01', key: 'a', v: 5 },
      { t: '2026-11-02', key: 'a', v: 1 },
      { t: '2026-11-02', key: 'c', v: 9 }
    ], ['b'])
    expect(out.buckets).toEqual(['2026-11-01', '2026-11-02'])
    expect(out.datasets).toEqual([
      { key: 'b', data: [0, 1] },
      { key: 'c', data: [0, 9] },
      { key: 'a', data: [5, 1] }
    ])
  })

  it('shades retention cells', () => {
    expect(retentionAlpha(null)).toBe(0)
    expect(retentionAlpha(0)).toBeCloseTo(0.06)
    expect(retentionAlpha(50)).toBeCloseTo(0.5)
    expect(retentionAlpha(140)).toBe(1)
  })
})

describe('stats CSV', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('quotes, escapes and defuses formulas', () => {
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('=SUM(A1)')).toBe('\'=SUM(A1)')
    expect(csvCell(-3)).toBe('-3')
    expect(csvCell(Number.NaN)).toBe('')
    expect(csvCell(null)).toBe('')
    expect(toCsv(['a', 'b'], [[1, 'x'], [null, 'y\nz']])).toBe('a,b\r\n1,x\r\n,"y\nz"\r\n')
  })

  it('names the file after table, range and day', () => {
    expect(csvFileName('AI cost', '30', '2026-11-17')).toBe('markoto-stats-ai-cost-30d-2026-11-17.csv')
    expect(csvFileName('plan-mix', 'all', '2026-11-17')).toBe('markoto-stats-plan-mix-all-2026-11-17.csv')
  })

  it('downloads through an object URL', () => {
    const create = vi.fn(() => 'blob:x')
    const revoke = vi.fn()
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    downloadCsv('a.csv', 'x\r\n')
    expect(create).toHaveBeenCalledOnce()
    expect(click).toHaveBeenCalledOnce()
    expect(revoke).toHaveBeenCalledWith('blob:x')
  })
})
