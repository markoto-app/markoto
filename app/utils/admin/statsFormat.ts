// Number formatting and chart data shaping for the admin's product stats
// (`/admin/stats`). Pure, locale passed in, so the page and the tests agree.

import { percentChange, type Kpi, type SeriesPoint, type StatsBucket } from '~~/shared/contracts/adminStats'

export function statsCount(n: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(n)
}

export function statsPercent(n: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(n) + ' %'
}

export function statsMoney(amount: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: currency.toUpperCase(), maximumFractionDigits: 2 }).format(amount)
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/** Bytes in decimal units (1 KB = 1000 B), one decimal from MB up. */
export function statsBytes(bytes: number, locale: string): string {
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000
    unit++
  }
  const digits = unit >= 2 ? 1 : 0
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value)} ${BYTE_UNITS[unit]}`
}

/** The change of a KPI as `+12 %` / `-3 %`, null when there is nothing to compare. */
export function statsChange(kpi: Kpi, locale: string): { text: string, direction: 'up' | 'down' | 'flat' } | null {
  const change = percentChange(kpi)
  if (change === null) return null
  const rounded = Math.round(change)
  const direction = rounded > 0 ? 'up' : rounded < 0 ? 'down' : 'flat'
  const sign = rounded > 0 ? '+' : ''
  return { text: `${sign}${new Intl.NumberFormat(locale).format(rounded)} %`, direction }
}

/** Axis label of a bucket start day: `17 Nov` for days and weeks, `Nov 2026` for months. */
export function statsBucketLabel(day: string, bucket: StatsBucket, locale: string): string {
  const d = new Date(`${day}T00:00:00Z`)
  const opts: Intl.DateTimeFormatOptions = bucket === 'month'
    ? { month: 'short', year: 'numeric', timeZone: 'UTC' }
    : { day: 'numeric', month: 'short', timeZone: 'UTC' }
  return new Intl.DateTimeFormat(locale, opts).format(d)
}

/**
 * Running total of a per-bucket series. With `endTotal` the series is
 * shifted so its last point equals it (accounts existing today by sign-up
 * month: sign-ups before the window are the starting level).
 */
export function cumulativeSeries(points: readonly SeriesPoint[], endTotal?: number): SeriesPoint[] {
  const offset = endTotal === undefined ? 0 : endTotal - points.reduce((n, p) => n + p.v, 0)
  let sum = offset
  return points.map((p) => {
    sum += p.v
    return { t: p.t, v: sum }
  })
}

/**
 * Pivot long rows (bucket, key, value) into one dataset per key over a
 * shared, sorted list of buckets; missing cells are 0. Keys keep the
 * order of `keyOrder` first, then the rest by total, largest first.
 */
export function pivotStatsSeries(
  rows: ReadonlyArray<{ t: string, key: string, v: number }>,
  keyOrder: readonly string[] = []
): { buckets: string[], datasets: Array<{ key: string, data: number[] }> } {
  const buckets = [...new Set(rows.map(r => r.t))].sort((a, b) => a.localeCompare(b))
  const totals = new Map<string, number>()
  for (const r of rows) totals.set(r.key, (totals.get(r.key) ?? 0) + r.v)
  const keys = [
    ...keyOrder.filter(k => totals.has(k)),
    ...[...totals.keys()].filter(k => !keyOrder.includes(k)).sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0))
  ]
  const index = new Map(buckets.map((b, i) => [b, i]))
  const datasets = keys.map((key) => {
    const data = Array.from({ length: buckets.length }, () => 0)
    for (const r of rows) {
      if (r.key !== key) continue
      const i = index.get(r.t)
      if (i !== undefined) data[i] = (data[i] ?? 0) + r.v
    }
    return { key, data }
  })
  return { buckets, datasets }
}

/** Background shade of a retention cell: 0 % transparent, 100 % full. */
export function retentionAlpha(pct: number | null): number {
  if (pct === null) return 0
  return Math.max(0.06, Math.min(1, pct / 100))
}
