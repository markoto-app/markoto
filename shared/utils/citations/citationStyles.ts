import { issuedYear, type CslDate, type CslItem, type CslName } from './cslItem'
import type { CiteRef, Locator } from './citeSyntax'
import { citationTerms, type CitationTerms } from './citationTerms'
import { referenceAnchorId } from './crossrefTerms'

/**
 * The citation styles markoto formats, implemented here rather than
 * through a CSL processor (citeproc-js is CPAL/AGPL licensed; see
 * docs/contributing/citations.md). Each style follows its published
 * rules for the common item types (journal article, book, chapter,
 * conference paper, report, thesis, web page); other types fall back to
 * the book or web shape. Output is HTML built from escaped text only, and
 * is sanitised again with the rest of the document.
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const i = (s: string) => (s ? `<i>${s}</i>` : '')
const sc = (s: string) => (s ? `<span class="csl-sc">${s}</span>` : '')
const q = (s: string, locale: string) => {
  const lang = locale.split('-')[0]
  if (lang === 'de') return `„${s}“`
  if (lang === 'fr') return `« ${s} »`
  return `“${s}”`
}
const sq = (s: string) => `‘${s}’`

/** Join non-empty parts with `sep`. */
function join(parts: ReadonlyArray<string | undefined | false>, sep: string): string {
  return parts.filter((p): p is string => typeof p === 'string' && p !== '').join(sep)
}

/** Append `.` unless the text already ends in sentence punctuation. */
function period(s: string): string {
  if (!s) return ''
  const plain = s.replace(/<[^>]+>/g, '')
  return /[.!?…]["'“”’»]?$/.test(plain) ? s : `${s}.`
}

/** Parts as sentences: each but the last ends with a period, joined by spaces. */
function sentences(parts: ReadonlyArray<string | undefined | false>): string {
  const kept = parts.filter((p): p is string => typeof p === 'string' && p !== '')
  return kept.map((p, idx) => (idx < kept.length - 1 ? period(p) : p)).join(' ')
}

/** "pp. 45–67" / "S. 45–67". */
function pagesText(page: string, t: CitationTerms): string {
  return locatorText({ label: 'page', value: pageRange(page) }, t)
}

/** APA's editor label: "Ed." / "Eds." (capitalised short term). */
function apaEditor(count: number, t: CitationTerms): string {
  const term = count > 1 ? t.editor[1] : t.editor[0]
  return term.charAt(0).toUpperCase() + term.slice(1)
}

/** DIN 1505-2 writes "u. a." whatever the other styles use. */
const DIN_ET_AL = 'u. a.'

function pageRange(p: string): string {
  return p.replace(/\s*(?:--?|–)\s*/g, '–')
}

function isRange(p: string): boolean {
  return /[–,&-]/.test(p)
}

function linkUrl(url: string): string {
  const safe = /^https?:\/\//i.test(url)
  const text = escapeHtml(url)
  return safe ? `<a href="${text}" target="_blank" rel="noopener noreferrer">${text}</a>` : text
}

function doiUrl(item: CslItem): string {
  return item.DOI ? linkUrl(`https://doi.org/${item.DOI}`) : ''
}

/** Item kinds the styles distinguish. */
type Shape = 'article' | 'book' | 'chapter' | 'web' | 'thesis' | 'report'

function shapeOf(item: CslItem): Shape {
  switch (item.type) {
    case 'article':
    case 'article-journal':
    case 'article-magazine':
    case 'article-newspaper':
      return item['container-title'] ? 'article' : 'book'
    case 'chapter':
    case 'paper-conference':
    case 'entry-encyclopedia':
    case 'entry-dictionary':
      return item['container-title'] ? 'chapter' : 'book'
    case 'webpage':
    case 'post':
    case 'post-weblog':
      return 'web'
    case 'thesis':
      return 'thesis'
    case 'report':
      return 'report'
    default:
      return item.URL && !item.publisher && !item.DOI ? 'web' : 'book'
  }
}

// Names

function family(n: CslName): string {
  if (n.literal) return n.literal
  return join([n['non-dropping-particle'], n.family], ' ')
}

/** Initials of given names: "John Ronald" → "J. R.", "Jean-Paul" → "J.-P." (`compact`: "JR"). */
export function initials(given: string | undefined, compact = false): string {
  if (!given) return ''
  const parts = given.split(/\s+/).filter(Boolean).map((w) => {
    if (/^\p{Lu}\.$/u.test(w)) return compact ? w[0] : w
    return w.split('-').map(h => (h ? (compact ? [...h][0] : `${[...h][0]}.`) : '')).join(compact ? '' : '-')
  })
  return compact ? parts.join('') : parts.join(' ')
}

function given(n: CslName): string {
  return join([n.given, n['dropping-particle']], ' ')
}

/** "Smith, J. A." */
function invertedInitials(n: CslName, compact = false): string {
  if (n.literal) return n.literal
  const g = initials(n.given, compact)
  const base = join([family(n), g], compact ? ' ' : ', ')
  return n.suffix ? `${base}, ${n.suffix}` : base
}

/** "J. A. Smith" */
function initialsFirst(n: CslName): string {
  if (n.literal) return n.literal
  return join([initials(n.given), family(n), n.suffix], ' ')
}

/** "Smith, John" */
function invertedFull(n: CslName): string {
  if (n.literal) return n.literal
  return join([join([family(n), given(n)], ', '), n.suffix], ', ')
}

/** "John Smith" */
function fullName(n: CslName): string {
  if (n.literal) return n.literal
  return join([given(n), family(n), n.suffix], ' ')
}

function esc(s: string | undefined): string {
  return s ? escapeHtml(s) : ''
}

/** List with "A, B, and C" (oxford) or "A, B and C". */
function andList(names: string[], and: string, oxford: boolean): string {
  if (names.length <= 1) return names[0] ?? ''
  if (names.length === 2) return `${names[0]} ${and} ${names[1]}`
  return `${names.slice(0, -1).join(', ')}${oxford ? ',' : ''} ${and} ${names.at(-1)}`
}

function primaryNames(item: CslItem): { names: CslName[], role: 'author' | 'editor' | null } {
  if (item.author?.length) return { names: item.author, role: 'author' }
  if (item.editor?.length) return { names: item.editor, role: 'editor' }
  return { names: [], role: null }
}

// Dates

function dateOf(d: CslDate | undefined): { year?: number, month?: number, day?: number, literal?: string } {
  const p = d?.['date-parts']?.[0]
  if (p) return { year: p[0], month: p[1], day: p[2] }
  return d?.literal ? { literal: d.literal } : {}
}

function yearText(item: CslItem, ctx: FormatContext): string {
  const y = issuedYear(item)
  const suffix = ctx.yearSuffix.get(item.id) ?? ''
  if (y !== null) return `${y}${suffix}`
  return item.issued?.literal ? `${escapeHtml(item.issued.literal)}${suffix}` : `${ctx.terms.noDate}${suffix ? `-${suffix}` : ''}`
}

function longDate(d: CslDate | undefined, locale: string, monthStyle: 'long' | 'short' = 'long'): string {
  const { year, month, day, literal } = dateOf(d)
  if (literal) return escapeHtml(literal)
  if (year === undefined) return ''
  if (!month) return String(year)
  try {
    const date = new Date(Date.UTC(year, month - 1, day ?? 1))
    const opts: Intl.DateTimeFormatOptions = day ? { year: 'numeric', month: monthStyle, day: 'numeric', timeZone: 'UTC' } : { year: 'numeric', month: monthStyle, timeZone: 'UTC' }
    return escapeHtml(new Intl.DateTimeFormat(locale, opts).format(date))
  } catch {
    return String(year)
  }
}

function editionText(item: CslItem, terms: CitationTerms): string {
  const e = item.edition
  if (!e) return ''
  const n = Number.parseInt(e, 10)
  if (Number.isFinite(n) && String(n) === e.trim()) return n === 1 ? '' : `${terms.ordinal(n)} ${terms.edition}`
  return escapeHtml(e)
}

function locatorText(loc: Locator | undefined, terms: CitationTerms, bare = false): string {
  if (!loc) return ''
  if (bare && loc.label === 'page') return escapeHtml(loc.value)
  const [one, many] = terms.locators[loc.label]
  return `${isRange(loc.value) ? many : one} ${escapeHtml(loc.value)}`
}

// In-text author part (author-date styles)

function citeAuthors(item: CslItem, ctx: FormatContext, narrative: boolean): string {
  const { names } = primaryNames(item)
  const t = ctx.terms
  if (names.length === 0) {
    const title = item['title-short'] ?? item.title ?? ''
    const shape = shapeOf(item)
    return shape === 'book' || shape === 'report' || shape === 'thesis' ? i(esc(title)) : q(esc(title), ctx.locale)
  }
  const fam = names.map(n => esc(family(n)))
  switch (ctx.style) {
    case 'apa':
      if (fam.length >= 3) return `${fam[0]} ${t.etAl}`
      return fam.length === 2 ? `${fam[0]} ${narrative ? t.and : '&amp;'} ${fam[1]}` : fam[0] ?? ''
    case 'chicago-author-date':
      return fam.length >= 4 ? `${fam[0]} ${t.etAl}` : andList(fam, t.and, true)
    case 'harvard':
      return fam.length >= 4 ? `${fam[0]} ${t.etAl}` : andList(fam, t.and, false)
    case 'din-1505-2':
      if (fam.length >= 3) return `${sc(fam[0] ?? '')} ${DIN_ET_AL}`
      return fam.map(sc).join(' ; ')
    default:
      return fam[0] ?? ''
  }
}

// Cluster formatting

export interface ClusterEntry {
  item: CslItem
  ref: CiteRef
}

function anchor(key: string, html: string): string {
  return `<a href="#${escapeHtml(referenceAnchorId(key))}" class="csl-cite-link">${html}</a>`
}

function withAffixes(ref: CiteRef, core: string): string {
  return join([ref.prefix ? esc(ref.prefix) : '', core], ' ') + (ref.suffix ? `, ${esc(ref.suffix)}` : '')
}

/**
 * One citation cluster (`[@a; @b, p. 3]`) in `ctx.style`. `narrative`
 * for a bare `@key` in the running text ("Smith (2020)").
 */
export function formatCluster(entries: readonly ClusterEntry[], ctx: FormatContext, narrative: boolean): string {
  if (entries.length === 0) return ''
  const t = ctx.terms
  if (styleKind(ctx.style) === 'numeric') {
    const num = (e: ClusterEntry) => String(ctx.numbers.get(e.item.id) ?? '?')
    if (ctx.style === 'ieee') {
      const parts = entries.map(e => anchor(e.item.id, `[${join([num(e), locatorText(e.ref.locator, t)], ', ')}]`))
      return withAffixes({ ...entries[0]!.ref, suffix: '' }, parts.join(', ')) + (entries.at(-1)?.ref.suffix ? `, ${esc(entries.at(-1)?.ref.suffix)}` : '')
    }
    // Vancouver: (1, 3, p. 12)
    const parts = entries.map(e => anchor(e.item.id, join([num(e), locatorText(e.ref.locator, t)], ' ')))
    return `(${withAffixes({ ...entries[0]!.ref, suffix: '' }, parts.join(', '))}${entries.at(-1)?.ref.suffix ? `, ${esc(entries.at(-1)?.ref.suffix)}` : ''})`
  }

  const chicago = ctx.style === 'chicago-author-date'
  const din = ctx.style === 'din-1505-2'
  const yearAndLocator = (e: ClusterEntry) => {
    const loc = locatorText(e.ref.locator, t, chicago)
    return join([yearText(e.item, ctx), loc], chicago || din ? ', ' : ', ')
  }
  if (narrative) {
    return entries.map((e) => {
      const inner = join([e.ref.prefix ? esc(e.ref.prefix) : '', yearAndLocator(e)], ' ') + (e.ref.suffix ? `, ${esc(e.ref.suffix)}` : '')
      return anchor(e.item.id, `${citeAuthors(e.item, ctx, true)} (${inner})`)
    }).join('; ')
  }
  const sep = chicago || din ? ' ' : ', '
  const parts = entries.map((e) => {
    const body = e.ref.suppressAuthor ? yearAndLocator(e) : `${citeAuthors(e.item, ctx, false)}${sep}${yearAndLocator(e)}`
    return withAffixes(e.ref, anchor(e.item.id, body))
  })
  return `(${parts.join('; ')})`
}

// Bibliography entries

function apaNames(names: CslName[]): string {
  const list = names.map(n => esc(invertedInitials(n)))
  if (list.length === 1) return list[0] ?? ''
  if (list.length > 20) return `${list.slice(0, 19).join(', ')}, … ${list.at(-1)}`
  return `${list.slice(0, -1).join(', ')}, &amp; ${list.at(-1)}`
}

function apaEntry(item: CslItem, ctx: FormatContext): string {
  const t = ctx.terms
  const { names, role } = primaryNames(item)
  const shape = shapeOf(item)
  const title = esc(item.title)
  const container = esc(item['container-title'])
  let who = names.length ? apaNames(names) : ''
  if (role === 'editor') who += ` (${apaEditor(names.length, t)})`
  const date = `(${yearText(item, ctx)})`
  const ed = editionText(item, t)
  const doi = doiUrl(item) || (item.URL ? linkUrl(item.URL) : '')
  const titleOnly = !who
  let titlePart = ''
  let rest = ''
  if (shape === 'article') {
    titlePart = period(title)
    const vol = item.volume ? i(esc(item.volume)) : ''
    const vi = vol + (item.issue ? `(${esc(item.issue)})` : '')
    rest = period(join([i(container), vi, item.page ? pageRange(esc(item.page)) : ''], ', '))
  } else if (shape === 'chapter') {
    titlePart = period(title)
    const eds = item.editor?.length ? `${andList(item.editor.map(n => esc(initialsFirst(n))), '&amp;', false)} (${apaEditor(item.editor.length, t)}), ` : ''
    const pages = item.page ? ` (${pagesText(item.page, t)})` : ''
    rest = join([period(`${t.in} ${eds}${i(container)}${pages}`), item.publisher ? period(esc(item.publisher)) : ''], ' ')
  } else if (shape === 'thesis') {
    const kind = /master/i.test(item.genre ?? '') ? t.mastersThesis : t.doctoralThesis
    titlePart = period(`${i(title)} [${join([kind, esc(item.publisher)], ', ')}]`)
  } else if (shape === 'web') {
    titlePart = period(i(title))
    rest = container ? period(container) : ''
  } else {
    const paren = join([ed, shape === 'report' && item.number ? `${t.report} No. ${esc(item.number)}` : ''], '; ')
    titlePart = period(i(title) + (paren ? ` (${paren})` : ''))
    rest = item.publisher && item.publisher !== names.map(family).join('') ? period(esc(item.publisher)) : ''
  }
  const head = titleOnly ? `${titlePart} ${period(date)}` : `${period(who)} ${period(date)} ${titlePart}`
  return join([head, rest, doi], ' ')
}

function chicagoNames(names: CslName[], t: CitationTerms): string {
  const shown = names.length > 10 ? names.slice(0, 7) : names
  const list = shown.map((n, idx) => esc(idx === 0 ? invertedFull(n) : fullName(n)))
  const text = list.length === 2 ? `${list[0]}, ${t.and} ${list[1]}` : andList(list, t.and, true)
  return names.length > 10 ? `${list.join(', ')}, ${t.etAl}` : text
}

function chicagoEntry(item: CslItem, ctx: FormatContext): string {
  const t = ctx.terms
  const { names, role } = primaryNames(item)
  const shape = shapeOf(item)
  const title = esc(item.title)
  const container = esc(item['container-title'])
  let who = names.length ? chicagoNames(names, t) : ''
  if (role === 'editor') who += `, ${names.length > 1 ? t.editor[1] : t.editor[0]}`
  const year = yearText(item, ctx)
  const place = join([esc(item['publisher-place']), esc(item.publisher)], ': ')
  const link = doiUrl(item) || (item.URL ? linkUrl(item.URL) : '')
  let body = ''
  if (shape === 'article') {
    const vi = join([esc(item.volume), item.issue ? `(${esc(item.issue)})` : ''], ' ')
    body = period(q(period(title), ctx.locale)) + ' ' + period(join([i(container), vi], ' ') + (item.page ? `: ${pageRange(esc(item.page))}` : ''))
  } else if (shape === 'chapter') {
    const eds = item.editor?.length ? `, ${t.editedBy} ${andList(item.editor.map(n => esc(fullName(n))), t.and, true)}` : ''
    body = `${period(q(period(title), ctx.locale))} ${period(`${t.in} ${i(container)}${eds}${item.page ? `, ${pageRange(esc(item.page))}` : ''}`)} ${period(place)}`
  } else if (shape === 'web') {
    body = join([period(q(period(title), ctx.locale)), container ? period(container) : ''], ' ')
  } else if (shape === 'thesis') {
    body = join([period(q(period(title), ctx.locale)), period(join([esc(item.genre) || t.doctoralThesis, esc(item.publisher)], ', '))], ' ')
  } else {
    body = join([period(i(title)), period(editionText(item, t)), period(place)], ' ')
  }
  const head = who ? `${period(who)} ${period(year)}` : ''
  return join([head, body.trim(), link ? period(link) : ''], ' ')
}

function harvardNames(names: CslName[], t: CitationTerms): string {
  const list = names.map(n => esc(invertedInitials(n)))
  if (list.length >= 4) return `${list[0]} ${t.etAl}`
  return andList(list, t.and, false)
}

function harvardEntry(item: CslItem, ctx: FormatContext): string {
  const t = ctx.terms
  const { names, role } = primaryNames(item)
  const shape = shapeOf(item)
  const title = esc(item.title)
  const container = esc(item['container-title'])
  let who = names.length ? harvardNames(names, t) : ''
  if (role === 'editor') who += ` (${names.length > 1 ? t.editor[1] : t.editor[0]})`
  const head = `${who || i(title)} (${yearText(item, ctx)})`
  const place = join([esc(item['publisher-place']), esc(item.publisher)], ': ')
  const available = item.DOI ? `${t.availableAt}: ${doiUrl(item)}` : item.URL ? `${t.availableAt}: ${linkUrl(item.URL)}${item.accessed ? ` (${t.accessed}: ${longDate(item.accessed, ctx.locale)})` : ''}` : ''
  const pages = item.page ? `${pagesText(item.page, t)}` : ''
  let body = ''
  if (shape === 'article') {
    const vi = esc(item.volume) + (item.issue ? `(${esc(item.issue)})` : '')
    body = `${sq(title)}, ${join([i(container), vi, pages], ', ')}`
  } else if (shape === 'chapter') {
    const eds = item.editor?.length ? `${harvardNames(item.editor, t)} (${item.editor.length > 1 ? t.editor[1] : t.editor[0]}) ` : ''
    body = `${sq(title)}, ${t.in.toLowerCase()} ${eds}${i(container)}. ${join([place, pages], ', ')}`
  } else if (shape === 'web') {
    body = sentences([i(title), container])
  } else {
    // Cite Them Right abbreviates "edition" as "edn".
    const edition = t.edition === 'ed.' ? editionText(item, t).replace(/ ed\.$/, ' edn') : editionText(item, t)
    body = sentences([who ? i(title) : '', shape === 'thesis' ? join([esc(item.genre) || t.doctoralThesis, esc(item.publisher)], '. ') : '', edition, shape === 'thesis' ? '' : place])
  }
  return join([head, period(body), available ? period(available) : ''], ' ')
}

function ieeeNames(names: CslName[], t: CitationTerms): string {
  if (names.length > 6) return `${esc(initialsFirst(names[0]!))} ${t.etAl}`
  const list = names.map(n => esc(initialsFirst(n)))
  return list.length === 2 ? `${list[0]} ${t.and} ${list[1]}` : andList(list, t.and, true)
}

function ieeeEntry(item: CslItem, ctx: FormatContext): string {
  const t = ctx.terms
  const { names, role } = primaryNames(item)
  const shape = shapeOf(item)
  const title = esc(item.title)
  const container = esc(item['container-title'])
  let who = names.length ? ieeeNames(names, t) : ''
  if (role === 'editor') who += `, ${names.length > 1 ? t.editor[1] : t.editor[0]}`
  const date = join([longDate(item.issued, ctx.locale, 'short').replace(/^\d{4}$/, ''), ''], '') || String(issuedYear(item) ?? '')
  const pages = item.page ? `${pagesText(item.page, t)}` : ''
  const doi = item.DOI ? `doi: ${esc(item.DOI)}` : ''
  const place = join([esc(item['publisher-place']), esc(item.publisher)], ': ')
  let body = ''
  if (shape === 'article') {
    body = period(join([`${q(`${title},`, ctx.locale)} ${i(container)}`, item.volume ? `${t.volume} ${esc(item.volume)}` : '', item.issue ? `${t.issue} ${esc(item.issue)}` : '', pages, date, doi], ', '))
  } else if (shape === 'chapter') {
    body = period(join([`${q(`${title},`, ctx.locale)} ${t.in.toLowerCase()} ${i(container)}`, place, date, pages, doi], ', '))
  } else if (shape === 'web') {
    body = join([period(join([q(`${title},`, ctx.locale).replace(/,(”|“|»)$/, '$1'), container], ' ')), item.accessed ? period(`${t.accessed}: ${longDate(item.accessed, ctx.locale, 'short')}`) : '', item.URL ? `[Online]. Available: ${linkUrl(item.URL)}` : ''], ' ')
  } else if (shape === 'thesis') {
    body = period(join([q(`${title},`, ctx.locale).replace(/,(”|“|»)$/, '$1'), esc(item.genre) || t.doctoralThesis, esc(item.publisher), date], ', '))
  } else {
    const ed = editionText(item, t)
    body = period(sentences([join([i(title), ed], ', '), join([place, date], ', ')]))
  }
  return join([who ? `${who},` : '', body, shape === 'web' || !item.URL || item.DOI ? '' : `[Online]. Available: ${linkUrl(item.URL)}`], ' ')
}

function vancouverNames(names: CslName[], t: CitationTerms): string {
  const shown = names.slice(0, 6).map(n => esc(n.literal ?? join([family(n), initials(n.given, true)], ' ')))
  return shown.join(', ') + (names.length > 6 ? `, ${t.etAl}` : '')
}

function vancouverEntry(item: CslItem, ctx: FormatContext): string {
  const t = ctx.terms
  const { names, role } = primaryNames(item)
  const shape = shapeOf(item)
  const title = esc(item.title)
  const container = esc(item['container-title-short'] ?? item['container-title'])
  let who = names.length ? vancouverNames(names, t) : ''
  if (role === 'editor') who += `, ${names.length > 1 ? 'editors' : 'editor'}`
  const year = yearText(item, ctx)
  const place = join([esc(item['publisher-place']), esc(item.publisher)], ': ')
  let body = ''
  if (shape === 'article') {
    const vi = join([esc(item.volume), item.issue ? `(${esc(item.issue)})` : ''], '')
    body = `${period(title)} ${period(container)} ${year}${vi ? `;${vi}` : ''}${item.page ? `:${pageRange(esc(item.page))}` : ''}.`
  } else if (shape === 'chapter') {
    const eds = item.editor?.length ? `${vancouverNames(item.editor, t)}, ${item.editor.length > 1 ? 'editors' : 'editor'}. ` : ''
    body = `${period(title)} ${t.in}: ${eds}${period(container)} ${place}; ${year}.${item.page ? ` p. ${pageRange(esc(item.page))}.` : ''}`
  } else if (shape === 'web') {
    body = `${title} [Internet]. ${container ? `${container}; ` : ''}${year}${item.accessed ? ` [cited ${longDate(item.accessed, 'en', 'short')}]` : ''}.${item.URL ? ` Available from: ${linkUrl(item.URL)}` : ''}`
  } else {
    body = join([period(title + (shape === 'thesis' ? ` [${esc(item.genre) || t.doctoralThesis}]` : '')), period(editionText(item, t)), `${place}${place ? '; ' : ''}${year}.`], ' ')
  }
  const doi = item.DOI ? ` doi:${esc(item.DOI)}` : ''
  return `${who ? `${period(who)} ` : ''}${body}${doi}`
}

function dinNames(names: CslName[], t: CitationTerms): string {
  const shown = names.length > 3 ? names.slice(0, 1) : names
  const list = shown.map(n => (n.literal ? esc(n.literal) : `${sc(esc(family(n)))}${n.given ? `, ${esc(given(n))}` : ''}`))
  return list.join(' ; ') + (names.length > 3 ? ` ; ${DIN_ET_AL}` : '')
}

function dinEntry(item: CslItem, ctx: FormatContext): string {
  const t = ctx.terms
  const { names, role } = primaryNames(item)
  const shape = shapeOf(item)
  const title = esc(item.title)
  const container = esc(item['container-title'])
  let who = names.length ? dinNames(names, t) : ''
  if (role === 'editor') who += ` (${t.editor[0]})`
  const year = yearText(item, ctx)
  const place = join([esc(item['publisher-place']), esc(item.publisher)], ' : ')
  const pages = item.page ? `S. ${pageRange(esc(item.page))}` : ''
  let body = ''
  if (shape === 'article') {
    body = `${title}. ${t.in}: ${container}${item.volume ? ` ${t.volume} ${esc(item.volume)}` : ''} (${year})${item.issue ? `, ${t.issue} ${esc(item.issue)}` : ''}${pages ? `, ${pages}` : ''}`
  } else if (shape === 'chapter') {
    const eds = item.editor?.length ? `${dinNames(item.editor, t)} (${t.editor[0]}): ` : ''
    body = `${title}. ${t.in}: ${eds}${container}. ${join([place, year], ', ')}${pages ? `, ${pages}` : ''}`
  } else if (shape === 'web') {
    body = sentences([title, container, item.URL ? linkUrl(item.URL) : '', item.accessed ? `${t.accessed.toLowerCase()} ${longDate(item.accessed, 'de')}` : ''])
  } else {
    body = sentences([title, shape === 'thesis' ? join([esc(item.genre) || t.doctoralThesis, esc(item.publisher)], ', ') : '', editionText(item, t), shape === 'thesis' ? year : join([place, year], ', ')])
  }
  const doi = item.DOI ? ` – ${doiUrl(item)}` : ''
  return `${who ? `${who}: ` : ''}${body}${doi}`
}

/** One bibliography entry (inner HTML, without the number label of numeric styles). */
export function formatEntry(item: CslItem, ctx: FormatContext): string {
  switch (ctx.style) {
    case 'apa': return apaEntry(item, ctx)
    case 'chicago-author-date': return chicagoEntry(item, ctx)
    case 'harvard': return harvardEntry(item, ctx)
    case 'ieee': return ieeeEntry(item, ctx)
    case 'vancouver': return vancouverEntry(item, ctx)
    case 'din-1505-2': return dinEntry(item, ctx)
  }
}

/** Sort key for author-date bibliographies: first name's family (without particle), year, title. */
function sortKey(item: CslItem): string {
  const first = primaryNames(item).names[0]
  const name = first ? (first.literal ?? join([first.family, first.given], ' ')) : (item.title ?? '')
  const names = primaryNames(item).names.map(n => n.family ?? n.literal ?? '').join(' ')
  return `${name}\u0000${names}\u0000${issuedYear(item) ?? 9999}\u0000${item.title ?? ''}`.toLocaleLowerCase()
}

/** Author-year key used for `2020a` / `2020b` disambiguation. */
function disambiguationKey(item: CslItem): string {
  return `${primaryNames(item).names.map(n => family(n)).join('|')}\u0000${issuedYear(item) ?? 'nd'}`.toLocaleLowerCase()
}

export interface BibliographyPlan {
  /** Entries in bibliography order. */
  items: CslItem[]
  ctx: FormatContext
}

/**
 * Order the cited entries for `style` and compute what the citations need:
 * entry numbers (numeric styles: order of first citation) or year suffixes
 * (author-date styles: same authors + year → `2020a`, `2020b`, by title).
 */
export function planBibliography(citedInOrder: readonly CslItem[], style: CitationStyleId, locale: string): BibliographyPlan {
  if (styleKind(style) === 'numeric') {
    const numbers = new Map(citedInOrder.map((item, idx) => [item.id, idx + 1]))
    return { items: [...citedInOrder], ctx: formatContext(style, locale, numbers) }
  }
  const sorted = [...citedInOrder].sort((a, b) => sortKey(a).localeCompare(sortKey(b), locale))
  const groups = new Map<string, CslItem[]>()
  for (const item of sorted) {
    const k = disambiguationKey(item)
    groups.set(k, [...(groups.get(k) ?? []), item])
  }
  const suffix = new Map<string, string>()
  for (const group of groups.values()) {
    if (group.length < 2) continue
    group.forEach((item, idx) => suffix.set(item.id, idx < 26 ? String.fromCodePoint(97 + idx) : String(idx + 1)))
  }
  return { items: sorted, ctx: formatContext(style, locale, new Map(), suffix) }
}

/** The whole bibliography as HTML (one `div.csl-entry` per item, ids `ref-<key>`). */
export function formatBibliography(plan: BibliographyPlan): string {
  const numeric = styleKind(plan.ctx.style) === 'numeric'
  const entries = plan.items.map((item) => {
    const body = formatEntry(item, plan.ctx)
    const id = escapeHtml(referenceAnchorId(item.id))
    if (!numeric) return `<div class="csl-entry" id="${id}">${body}</div>`
    const n = plan.ctx.numbers.get(item.id) ?? 0
    const label = plan.ctx.style === 'ieee' ? `[${n}]` : `${n}.`
    return `<div class="csl-entry" id="${id}"><span class="csl-left-margin">${label}</span><span class="csl-right-inline">${body}</span></div>`
  })
  return `<div class="csl-bib-body csl-${numeric ? 'numeric' : 'author-date'} csl-style-${plan.ctx.style}">${entries.join('')}</div>`
}

/** Plain text of formatted HTML (hover cards, AI tools). */
export function htmlToText(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'')
}

/** One entry as plain text in `style` (no year suffix or number). */
export function formatEntryText(item: CslItem, style: CitationStyleId, locale: string): string {
  return htmlToText(formatEntry(item, formatContext(style, locale)))
}
