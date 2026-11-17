// CSV export of the admin's stats tables. RFC 4180 quoting; a cell that
// starts like a spreadsheet formula is prefixed with `'`, so opening the
// file in a spreadsheet never runs one.

export type CsvCell = string | number | null | undefined

const FORMULA_START = /^[=+\-@\t\r]/

export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  const text = FORMULA_START.test(value) ? `'${value}` : value
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function toCsv(header: readonly string[], rows: ReadonlyArray<readonly CsvCell[]>): string {
  return [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

/** `markoto-stats-users-30d-2026-11-17.csv`: a stable, sortable name. */
export function csvFileName(table: string, range: string, today: string): string {
  const slug = table.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-|-$/g, '')
  return `markoto-stats-${slug}-${range === 'all' ? 'all' : `${range}d`}-${today}.csv`
}

/** Hand the CSV to the browser as a download (UTF-8 with BOM, so spreadsheets read umlauts). */
export function downloadCsv(fileName: string, csv: string): void {
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}
