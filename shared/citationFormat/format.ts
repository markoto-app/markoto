import { issuedYear, type CslDate, type CslItem, type CslName } from '../utils/citations/cslItem'
import type { Locator } from '../utils/citations/citeSyntax'
import { citationTerms, type CitationTerms } from '../utils/citations/citationTerms'

/**
 * Building blocks of the citation formatter (shared/utils/citations/citationStyles.ts,
 * entries.ts): the style registry, the format context and the
 * text helpers. Every helper escapes the CSL text it prints.
 */

export const CITATION_STYLE_IDS = ['apa', 'chicago-author-date', 'harvard', 'ieee', 'vancouver', 'din-1505-2'] as const
export type CitationStyleId = typeof CITATION_STYLE_IDS[number]
export const DEFAULT_CITATION_STYLE: CitationStyleId = 'apa'

export interface CitationStyleInfo {
  id: CitationStyleId
  /** Name shown in pickers (proper names, not translated). */
  label: string
  kind: 'author-date' | 'numeric'
}

export const CITATION_STYLES: readonly CitationStyleInfo[] = [
  { id: 'apa', label: 'APA (7th edition)', kind: 'author-date' },
  { id: 'chicago-author-date', label: 'Chicago (author-date)', kind: 'author-date' },
  { id: 'harvard', label: 'Harvard (Cite Them Right)', kind: 'author-date' },
  { id: 'ieee', label: 'IEEE', kind: 'numeric' },
  { id: 'vancouver', label: 'Vancouver', kind: 'numeric' },
  { id: 'din-1505-2', label: 'DIN 1505-2 (author-year)', kind: 'author-date' }
]

export function isCitationStyleId(v: unknown): v is CitationStyleId {
  return typeof v === 'string' && (CITATION_STYLE_IDS as readonly string[]).includes(v)
}

export function citationStyleOf(v: unknown): CitationStyleId {
  return isCitationStyleId(v) ? v : DEFAULT_CITATION_STYLE
}

export function styleKind(style: CitationStyleId): 'author-date' | 'numeric' {
  return CITATION_STYLES.find(s => s.id === style)?.kind ?? 'author-date'
}

export interface FormatContext {
  style: CitationStyleId
  locale: string
  terms: CitationTerms
  /** Numeric styles: the entry number of each cited key. */
  numbers: ReadonlyMap<string, number>
  /** Author-date styles: `a`, `b` … for same author + year. */
  yearSuffix: ReadonlyMap<string, string>
}

export function formatContext(style: CitationStyleId, locale: string, numbers: ReadonlyMap<string, number> = new Map(), yearSuffix: ReadonlyMap<string, string> = new Map()): FormatContext {
  return { style, locale, terms: citationTerms(style === 'din-1505-2' ? 'de' : locale), numbers, yearSuffix }
}

// Text helpers

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export function esc(s: string | undefined): string {
  return s ? escapeHtml(s) : ''
}

/** Text without tags (a scanner: the input is our own markup). */
export function stripTags(html: string): string {
  let out = ''
  let inTag = false
  for (const ch of html) {
    if (ch === '<') inTag = true
    else if (ch === '>' && inTag) inTag = false
    else if (!inTag) out += ch
  }
  return out
}

export const NBSP = '\u00A0'

export const italic = (s: string): string => (s ? `<i>${s}</i>` : '')
export const smallCaps = (s: string): string => (s ? `<span class="csl-sc">${s}</span>` : '')

/** Double quotes in the document language. */
export function quoted(s: string, locale: string): string {
  const lang = locale.split('-')[0]
  if (lang === 'de') return `„${s}“`
  if (lang === 'fr') return `«${NBSP}${s}${NBSP}»`
  return `“${s}”`
}

export const singleQuoted = (s: string): string => `‘${s}’`

/** Join non-empty parts with `sep`. */
export function join(parts: ReadonlyArray<string | undefined | false>, sep: string): string {
  return parts.filter((p): p is string => typeof p === 'string' && p !== '').join(sep)
}

const SENTENCE_END = new Set(['.', '!', '?', '…'])
const CLOSING_QUOTES = new Set(['"', '\'', '“', '”', '’', '»'])

/** Append `.` unless the text already ends in sentence punctuation. */
export function period(s: string): string {
  if (!s) return ''
  const chars = [...stripTags(s)]
  let last = chars.at(-1) ?? ''
  if (CLOSING_QUOTES.has(last)) last = chars.at(-2) ?? ''
  return SENTENCE_END.has(last) ? s : `${s}.`
}

/** Parts as sentences: each but the last ends with a period, joined by spaces. */
export function sentences(parts: ReadonlyArray<string | undefined | false>): string {
  const kept = parts.filter((p): p is string => typeof p === 'string' && p !== '')
  return kept.map((p, idx) => (idx < kept.length - 1 ? period(p) : p)).join(' ')
}

/** `45--67`, `45 - 67` → `45–67`. */
export function pageRange(p: string): string {
  return p.replace(/-{1,2}|–/g, '–').split('–').map(s => s.trim()).join('–')
}

export function isRange(p: string): boolean {
  return /[–,&-]/.test(p)
}

export function linkUrl(url: string): string {
  const safe = /^https?:\/\//i.test(url)
  const text = escapeHtml(url)
  return safe ? `<a href="${text}" target="_blank" rel="noopener noreferrer">${text}</a>` : text
}

export function doiUrl(item: CslItem): string {
  return item.DOI ? linkUrl(`https://doi.org/${item.DOI}`) : ''
}

/** DOI link, else the URL link, else ''. */
export function doiOrUrl(item: CslItem): string {
  if (item.DOI) return doiUrl(item)
  return item.URL ? linkUrl(item.URL) : ''
}

/** Item kinds the styles distinguish. */
export type Shape = 'article' | 'book' | 'chapter' | 'web' | 'thesis' | 'report'

const SHAPE_BY_TYPE: Readonly<Record<string, Shape | 'article?' | 'chapter?'>> = {
  'article': 'article?',
  'article-journal': 'article?',
  'article-magazine': 'article?',
  'article-newspaper': 'article?',
  'chapter': 'chapter?',
  'paper-conference': 'chapter?',
  'entry-encyclopedia': 'chapter?',
  'entry-dictionary': 'chapter?',
  'webpage': 'web',
  'post': 'web',
  'post-weblog': 'web',
  'thesis': 'thesis',
  'report': 'report'
}

export function shapeOf(item: CslItem): Shape {
  const shape = SHAPE_BY_TYPE[item.type]
  if (shape === 'article?') return item['container-title'] ? 'article' : 'book'
  if (shape === 'chapter?') return item['container-title'] ? 'chapter' : 'book'
  if (shape) return shape
  return item.URL && !item.publisher && !item.DOI ? 'web' : 'book'
}

// Names

export function family(n: CslName): string {
  if (n.literal) return n.literal
  return join([n['non-dropping-particle'], n.family], ' ')
}

function initialOf(word: string, compact: boolean): string {
  if (!word) return ''
  const first = [...word][0] ?? ''
  return compact ? first : `${first}.`
}

/** Initials of given names: "John Ronald" → "J. R.", "Jean-Paul" → "J.-P." (`compact`: "JR"). */
export function initials(given: string | undefined, compact = false): string {
  if (!given) return ''
  const parts = given.split(/\s+/).filter(Boolean).map((w) => {
    if (/^\p{Lu}\.$/u.test(w)) return compact ? w.charAt(0) : w
    return w.split('-').map(h => initialOf(h, compact)).join(compact ? '' : '-')
  })
  return compact ? parts.join('') : parts.join(' ')
}

export function givenNames(n: CslName): string {
  return join([n.given, n['dropping-particle']], ' ')
}

/** "Smith, J. A." */
export function invertedInitials(n: CslName): string {
  if (n.literal) return n.literal
  const base = join([family(n), initials(n.given)], ', ')
  return n.suffix ? `${base}, ${n.suffix}` : base
}

/** "J. A. Smith" */
export function initialsFirst(n: CslName): string {
  if (n.literal) return n.literal
  return join([initials(n.given), family(n), n.suffix], ' ')
}

/** "Smith, John" */
export function invertedFull(n: CslName): string {
  if (n.literal) return n.literal
  return join([join([family(n), givenNames(n)], ', '), n.suffix], ', ')
}

/** "John Smith" */
export function fullName(n: CslName): string {
  if (n.literal) return n.literal
  return join([givenNames(n), family(n), n.suffix], ' ')
}

/** List with "A, B, and C" (oxford) or "A, B and C". */
export function andList(names: string[], and: string, oxford: boolean): string {
  if (names.length <= 1) return names[0] ?? ''
  if (names.length === 2) return `${names[0]} ${and} ${names[1]}`
  return `${names.slice(0, -1).join(', ')}${oxford ? ',' : ''} ${and} ${names.at(-1)}`
}

export function primaryNames(item: CslItem): { names: CslName[], role: 'author' | 'editor' | null } {
  if (item.author?.length) return { names: item.author, role: 'author' }
  if (item.editor?.length) return { names: item.editor, role: 'editor' }
  return { names: [], role: null }
}

/** Short editor term for `count` editors ("ed." / "eds."). */
export function editorTerm(count: number, t: CitationTerms): string {
  return count > 1 ? t.editor[1] : t.editor[0]
}

// Dates

function dateOf(d: CslDate | undefined): { year?: number, month?: number, day?: number, literal?: string } {
  const p = d?.['date-parts']?.[0]
  if (p) return { year: p[0], month: p[1], day: p[2] }
  return d?.literal ? { literal: d.literal } : {}
}

export function yearText(item: CslItem, ctx: FormatContext): string {
  const y = issuedYear(item)
  const suffix = ctx.yearSuffix.get(item.id) ?? ''
  if (y !== null) return `${y}${suffix}`
  if (item.issued?.literal) return `${escapeHtml(item.issued.literal)}${suffix}`
  return `${ctx.terms.noDate}${suffix ? `-${suffix}` : ''}`
}

export function longDate(d: CslDate | undefined, locale: string, monthStyle: 'long' | 'short' = 'long'): string {
  const { year, month, day, literal } = dateOf(d)
  if (literal) return escapeHtml(literal)
  if (year === undefined) return ''
  if (!month) return String(year)
  try {
    const date = new Date(Date.UTC(year, month - 1, day ?? 1))
    const opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: monthStyle, timeZone: 'UTC', ...(day ? { day: 'numeric' } : {}) }
    return escapeHtml(new Intl.DateTimeFormat(locale, opts).format(date))
  } catch {
    return String(year)
  }
}

export function editionText(item: CslItem, terms: CitationTerms): string {
  const e = item.edition
  if (!e) return ''
  const n = Number.parseInt(e, 10)
  if (Number.isFinite(n) && String(n) === e.trim()) return n === 1 ? '' : `${terms.ordinal(n)} ${terms.edition}`
  return escapeHtml(e)
}

export function locatorText(loc: Locator | undefined, terms: CitationTerms, bare = false): string {
  if (!loc) return ''
  if (bare && loc.label === 'page') return escapeHtml(loc.value)
  const [one, many] = terms.locators[loc.label]
  return `${isRange(loc.value) ? many : one}${NBSP}${escapeHtml(loc.value)}`
}

/** "pp. 45–67" / "S. 45–67". */
export function pagesText(page: string, t: CitationTerms): string {
  return locatorText({ label: 'page', value: pageRange(page) }, t)
}

/** Publisher place and name ("Berlin: Springer"). */
export function placeText(item: CslItem, sep = ': '): string {
  return join([esc(item['publisher-place']), esc(item.publisher)], sep)
}

/** Thesis kind: the entry's genre, else the doctoral-thesis term. */
export function genreText(item: CslItem, t: CitationTerms): string {
  return esc(item.genre) || t.doctoralThesis
}
