import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  COMPARE_MAX_AGE_MONTHS,
  compareClaims,
  compareSources,
  compareTable,
  formatCheckedDate,
  isStaleCheck,
  oldestCheck,
  parseCheckedDate,
  type CompareClaim,
  type CompareData,
  type CompareRow
} from '../../../shared/seo/compare'

// Comparison pages (/compare/<slug>): every competitor fact lives in
// content/compare/<slug>.yml with its source and the day it was checked.
// This suite fails once any check is older than nine months, so stale
// facts get re-verified at their source instead of quietly rotting.

const ROOT = join(__dirname, '..', '..', '..')
const DATA_DIR = join(ROOT, 'content', 'compare')
const PAGES_DIR = join(ROOT, 'content', 'marketing', 'en', 'compare')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toClaim(value: unknown, where: string): CompareClaim {
  if (!isRecord(value)) throw new Error(`${where}: not an object`)
  const v = value.value
  if (typeof v !== 'boolean' && typeof v !== 'string') throw new Error(`${where}.value: boolean or string`)
  if (typeof value.source !== 'string') throw new Error(`${where}.source: string`)
  if (typeof value.checked !== 'string') throw new Error(`${where}.checked: quoted YYYY-MM-DD string`)
  return { value: v, source: value.source, checked: value.checked }
}

function toRow(value: unknown, where: string): CompareRow {
  if (!isRecord(value) || typeof value.feature !== 'string') throw new Error(`${where}: needs a feature`)
  const note = value.note
  if (note !== undefined && typeof note !== 'string') throw new Error(`${where}.note: string`)
  return {
    feature: value.feature,
    ...(typeof note === 'string' ? { note } : {}),
    markoto: toClaim(value.markoto, `${where}.markoto`),
    competitor: toClaim(value.competitor, `${where}.competitor`)
  }
}

function loadData(slug: string): CompareData {
  const raw: unknown = parseYaml(readFileSync(join(DATA_DIR, `${slug}.yml`), 'utf8'))
  if (!isRecord(raw) || typeof raw.name !== 'string' || !Array.isArray(raw.rows)) {
    throw new Error(`${slug}.yml: needs name + rows`)
  }
  return { name: raw.name, rows: raw.rows.map((row, i) => toRow(row, `${slug}.yml rows[${i}]`)) }
}

/** A markoto source: a docs/legal page that exists, or a file in this repository. */
function markotoSourceExists(source: string): boolean {
  if (source.startsWith('/docs/')) {
    const rel = source.slice('/docs/'.length)
    return existsSync(join(ROOT, 'content', 'docs', `${rel}.md`)) || existsSync(join(ROOT, 'content', 'docs', rel, 'index.md'))
  }
  if (source.startsWith('/legal/')) {
    return existsSync(join(ROOT, 'content', 'legal', source.slice('/legal/'.length), 'en.md'))
  }
  if (source.startsWith('/')) return false
  return existsSync(join(ROOT, source))
}

const slugs = readdirSync(DATA_DIR).filter(f => f.endsWith('.yml')).map(f => f.slice(0, -'.yml'.length))

describe('check dates', () => {
  const today = new Date('2026-11-04T12:00:00Z')

  it('parses strict YYYY-MM-DD only', () => {
    expect(parseCheckedDate('2026-11-04')?.toISOString()).toBe('2026-11-04T00:00:00.000Z')
    expect(parseCheckedDate('2026-02-30')).toBeNull()
    expect(parseCheckedDate('4 Nov 2026')).toBeNull()
  })

  it(`counts a check older than ${COMPARE_MAX_AGE_MONTHS} months as stale`, () => {
    expect(isStaleCheck('2026-11-04', today)).toBe(false)
    expect(isStaleCheck('2026-02-04', today)).toBe(false)
    expect(isStaleCheck('2026-02-03', today)).toBe(true)
    expect(isStaleCheck('not a date', today)).toBe(true)
  })

  it('writes dates out per locale', () => {
    expect(formatCheckedDate('2026-11-04', 'en')).toBe('November 4, 2026')
    expect(formatCheckedDate('bad', 'en')).toBe('bad')
  })
})

describe('table + sources helpers', () => {
  const data: CompareData = {
    name: 'Other',
    rows: [
      { feature: 'A', note: 'n', markoto: { value: true, source: '/docs/x', checked: '2026-10-01' }, competitor: { value: 'Paid', source: 'https://example.com/p/', checked: '2026-11-01' } },
      { feature: 'B', markoto: { value: false, source: 'LICENSE', checked: '2026-11-02' }, competitor: { value: false, source: 'https://example.com/p/', checked: '2026-11-03' } }
    ]
  }

  it('puts markoto first and keeps notes', () => {
    expect(compareTable(data)).toEqual({
      columns: ['markoto', 'Other'],
      rows: [
        { label: 'A', note: 'n', values: [true, 'Paid'] },
        { label: 'B', values: [false, false] }
      ]
    })
  })

  it('lists each source once; repo paths are not links', () => {
    expect(compareSources(data)).toEqual({
      competitor: [{ href: 'https://example.com/p/', label: 'example.com/p', external: true }],
      markoto: [
        { href: '/docs/x', label: '/docs/x', external: false },
        { href: null, label: 'LICENSE', external: false }
      ]
    })
  })

  it('reports the oldest check', () => {
    expect(oldestCheck(data)).toBe('2026-10-01')
  })
})

describe('claim data (content/compare/*.yml)', () => {
  it('finds every comparison', () => {
    expect(slugs).toEqual(expect.arrayContaining(['hackmd', 'hedgedoc', 'overleaf', 'google-docs', 'obsidian', 'typora', 'typst']))
  })

  for (const slug of slugs) {
    describe(`${slug}`, () => {
      const data = loadData(slug)

      it('has rows with unique features', () => {
        expect(data.rows.length).toBeGreaterThanOrEqual(5)
        expect(new Set(data.rows.map(r => r.feature)).size).toBe(data.rows.length)
      })

      it(`every claim was checked in the last ${COMPARE_MAX_AGE_MONTHS} months, re-verify at the source, then update \`checked\``, () => {
        const today = new Date()
        for (const claim of compareClaims(data)) {
          expect(parseCheckedDate(claim.checked), `${claim.source}: ${claim.checked}`).not.toBeNull()
          expect(isStaleCheck(claim.checked, today), `stale: ${String(claim.value)} (${claim.source}, checked ${claim.checked})`).toBe(false)
        }
      })

      it('competitor sources are https URLs', () => {
        for (const row of data.rows) {
          expect(() => new URL(row.competitor.source), row.feature).not.toThrow()
          expect(row.competitor.source, row.feature).toMatch(/^https:\/\//)
        }
      })

      it('markoto sources point at an existing docs page or repository file', () => {
        for (const row of data.rows) {
          expect(markotoSourceExists(row.markoto.source), `${row.feature}: ${row.markoto.source}`).toBe(true)
        }
      })

      it('has a page that renders its table and keeps its sources in a comment', () => {
        const page = readFileSync(join(PAGES_DIR, `${slug}.md`), 'utf8')
        expect(page).toContain(`::compare-facts{competitor="${slug}"}`)
        // The source list is for our own fact checks, not for readers: it
        // stays in the page source, inside an HTML comment.
        expect(page).toContain(`::compare-note{competitor="${slug}"}`)
        expect(page).toMatch(new RegExp(`<!--[^]*?::compare-sources\\{competitor="${slug}"\\}[^]*?-->`))
        expect(page).toContain(`## Where ${data.name} is better`)
        expect(page).toMatch(/^navGroup: compare$/m)
      })
    })
  }

  it('the hub links every comparison page', () => {
    const hub = readFileSync(join(PAGES_DIR, 'index.md'), 'utf8')
    for (const slug of slugs) expect(hub).toContain(`](/compare/${slug})`)
  })
})

describe('licence wording on comparison pages', () => {
  const files = readdirSync(PAGES_DIR).filter(f => f.endsWith('.md'))
  for (const file of files) {
    it(`${file}: never calls markoto open source`, () => {
      const text = readFileSync(join(PAGES_DIR, file), 'utf8')
      expect(text).not.toMatch(/markoto is (an )?open[- ]source/i)
      expect(text).not.toMatch(/open[- ]source markoto/i)
    })
  }
})
