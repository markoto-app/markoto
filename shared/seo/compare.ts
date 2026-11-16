// Comparison pages (/compare/<slug>): claim data → table rows and the
// sources footer. Pure; used by the `::compare-facts` / `::compare-sources`
// content components and by the staleness test.
//
// Data: content/compare/<slug>.yml (Nuxt Content collection `compare`).
// Every cell is a claim with a value, a source and the day it was checked.
// A competitor's source is an https URL; markoto's is a site path of its
// own docs (`/docs/…`, `/legal/…`) or a path in this repository.

import { compareCodeUnits } from '../utils/compareCodeUnits'

export type CompareValue = boolean | string

export interface CompareClaim {
  value: CompareValue
  source: string
  /** YYYY-MM-DD. */
  checked: string
}

export interface CompareRow {
  feature: string
  note?: string
  markoto: CompareClaim
  competitor: CompareClaim
}

export interface CompareData {
  name: string
  rows: CompareRow[]
}

/** Months after which a checked claim counts as stale and must be re-verified. */
export const COMPARE_MAX_AGE_MONTHS = 9

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** A YYYY-MM-DD date as UTC midnight, or null when malformed. */
export function parseCheckedDate(value: string): Date | null {
  if (!DATE_RE.test(value)) return null
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date
}

/** A YYYY-MM-DD check date written out for a locale (`4 November 2026`); the raw string when malformed. */
export function formatCheckedDate(checked: string, locale: string): string {
  const date = parseCheckedDate(checked)
  return date
    ? date.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
    : checked
}

/** Whether a check is older than `COMPARE_MAX_AGE_MONTHS` on `today`. Malformed dates count as stale. */
export function isStaleCheck(checked: string, today: Date, maxAgeMonths = COMPARE_MAX_AGE_MONTHS): boolean {
  const date = parseCheckedDate(checked)
  if (!date) return true
  const limit = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - maxAgeMonths, today.getUTCDate()))
  return date.getTime() < limit.getTime()
}

/** Every claim of a data file, markoto's and the competitor's. */
export function compareClaims(data: CompareData): CompareClaim[] {
  return data.rows.flatMap(row => [row.markoto, row.competitor])
}

/** The oldest `checked` date of a data file (what the page says it was checked on). */
export function oldestCheck(data: CompareData): string | null {
  const dates = compareClaims(data).map(c => c.checked).filter(d => parseCheckedDate(d) !== null).sort(compareCodeUnits)
  return dates[0] ?? null
}

/** Props for `CompareTable` (`::compare-table`): markoto first, then the competitor. */
export function compareTable(data: CompareData): { columns: string[], rows: Array<{ label: string, values: CompareValue[], note?: string }> } {
  return {
    columns: ['markoto', data.name],
    rows: data.rows.map(row => ({
      label: row.feature,
      values: [row.markoto.value, row.competitor.value],
      ...(row.note ? { note: row.note } : {})
    }))
  }
}

export interface CompareSourceLink {
  /** Link target: absolute URL or site path; null for a path in markoto's source code (shown as text). */
  href: string | null
  /** Shown text. */
  label: string
  /** Opens off-site. */
  external: boolean
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

/** A markoto source: site paths link to the page, repository paths are shown as text. */
function markotoSourceLink(source: string): CompareSourceLink {
  if (source.startsWith('/')) return { href: source, label: source, external: false }
  return { href: null, label: source, external: false }
}

/** A competitor source as a link, labelled without the scheme. */
function competitorSourceLink(source: string): CompareSourceLink {
  return { href: source, label: source.replace(/^https?:\/\//, '').replace(/\/$/, ''), external: true }
}

/** The sources footer: competitor URLs, then markoto's references, each once, in table order. */
export function compareSources(data: CompareData): { competitor: CompareSourceLink[], markoto: CompareSourceLink[] } {
  return {
    competitor: unique(data.rows.map(r => r.competitor.source)).map(competitorSourceLink),
    markoto: unique(data.rows.map(r => r.markoto.source)).map(markotoSourceLink)
  }
}
