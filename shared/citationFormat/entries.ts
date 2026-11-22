import { issuedYear, type CslItem, type CslName } from '../utils/citations/cslItem'
import type { CitationTerms } from '../utils/citations/citationTerms'
import {
  andList, doiOrUrl, doiUrl, editionText, editorTerm, esc, family, fullName, genreText, givenNames,
  initials, initialsFirst, invertedFull, invertedInitials, italic, join, linkUrl, longDate, NBSP,
  pageRange, pagesText, period, placeText, primaryNames, quoted, sentences, shapeOf, singleQuoted,
  smallCaps, yearText, type FormatContext, type Shape
} from './format'

/**
 * Bibliography entries, one function per style and item shape. Each style
 * builds the common parts once (`EntryParts`) and hands them to the body
 * function of the item's shape.
 */

interface EntryParts {
  item: CslItem
  ctx: FormatContext
  t: CitationTerms
  shape: Shape
  names: CslName[]
  title: string
  container: string
}

function partsOf(item: CslItem, ctx: FormatContext): EntryParts {
  return {
    item,
    ctx,
    t: ctx.terms,
    shape: shapeOf(item),
    names: primaryNames(item).names,
    title: esc(item.title),
    container: esc(item['container-title'])
  }
}

type BodyTable<R> = Record<Shape, (p: EntryParts) => R>

/** "Ed." / "Eds." (capitalised short term). */
function apaEditor(count: number, t: CitationTerms): string {
  const term = editorTerm(count, t)
  return term.charAt(0).toUpperCase() + term.slice(1)
}

/** DIN 1505-2 writes "u. a." whatever the other styles use. */
export const DIN_ET_AL = `u.${NBSP}a.`

/** A title in double quotes ending with a comma inside them, the comma dropped (IEEE). */
function quotedTitle(p: EntryParts): string {
  return quoted(p.title, p.ctx.locale)
}

// APA 7

function apaNames(names: CslName[]): string {
  const list = names.map(n => esc(invertedInitials(n)))
  if (list.length === 1) return list[0] ?? ''
  if (list.length > 20) return `${list.slice(0, 19).join(', ')}, … ${list.at(-1)}`
  return `${list.slice(0, -1).join(', ')}, &amp; ${list.at(-1)}`
}

interface ApaBody { titlePart: string, rest: string }

function apaBook(p: EntryParts): ApaBody {
  const { item, t } = p
  const report = p.shape === 'report' && item.number ? `${t.report} No. ${esc(item.number)}` : ''
  const paren = join([editionText(item, t), report], '; ')
  const ownName = p.names.map(family).join('')
  return {
    titlePart: period(italic(p.title) + (paren ? ` (${paren})` : '')),
    rest: item.publisher && item.publisher !== ownName ? period(esc(item.publisher)) : ''
  }
}

const APA_BODY: BodyTable<ApaBody> = {
  article: (p) => {
    const { item } = p
    const vi = (item.volume ? italic(esc(item.volume)) : '') + (item.issue ? `(${esc(item.issue)})` : '')
    return { titlePart: period(p.title), rest: period(join([italic(p.container), vi, item.page ? pageRange(esc(item.page)) : ''], ', ')) }
  },
  chapter: (p) => {
    const { item, t } = p
    const eds = item.editor?.length ? `${andList(item.editor.map(n => esc(initialsFirst(n))), '&amp;', false)} (${apaEditor(item.editor.length, t)}), ` : ''
    const pages = item.page ? ` (${pagesText(item.page, t)})` : ''
    return { titlePart: period(p.title), rest: join([period(`${t.in} ${eds}${italic(p.container)}${pages}`), item.publisher ? period(esc(item.publisher)) : ''], ' ') }
  },
  thesis: (p) => {
    const kind = /master/i.test(p.item.genre ?? '') ? p.t.mastersThesis : p.t.doctoralThesis
    return { titlePart: period(`${italic(p.title)} [${join([kind, esc(p.item.publisher)], ', ')}]`), rest: '' }
  },
  web: p => ({ titlePart: period(italic(p.title)), rest: p.container ? period(p.container) : '' }),
  book: apaBook,
  report: apaBook
}

function apaEntry(item: CslItem, ctx: FormatContext): string {
  const p = partsOf(item, ctx)
  const { role } = primaryNames(item)
  let who = p.names.length ? apaNames(p.names) : ''
  if (role === 'editor') who += ` (${apaEditor(p.names.length, p.t)})`
  const date = `(${yearText(item, ctx)})`
  const { titlePart, rest } = APA_BODY[p.shape](p)
  const head = who ? `${period(who)} ${period(date)} ${titlePart}` : `${titlePart} ${period(date)}`
  return join([head, rest, doiOrUrl(item)], ' ')
}

// Chicago author-date

function chicagoNames(names: CslName[], t: CitationTerms): string {
  const shown = names.length > 10 ? names.slice(0, 7) : names
  const list = shown.map((n, idx) => esc(idx === 0 ? invertedFull(n) : fullName(n)))
  if (names.length > 10) return `${list.join(', ')}, ${t.etAl}`
  return list.length === 2 ? `${list[0]}, ${t.and} ${list[1]}` : andList(list, t.and, true)
}

const chicagoTitle = (p: EntryParts) => period(quoted(period(p.title), p.ctx.locale))

const CHICAGO_BODY: BodyTable<string> = {
  article: (p) => {
    const { item } = p
    const vi = join([esc(item.volume), item.issue ? `(${esc(item.issue)})` : ''], ' ')
    const pages = item.page ? `: ${pageRange(esc(item.page))}` : ''
    return `${chicagoTitle(p)} ${period(join([italic(p.container), vi], ' ') + pages)}`
  },
  chapter: (p) => {
    const { item, t } = p
    const eds = item.editor?.length ? `, ${t.editedBy} ${andList(item.editor.map(n => esc(fullName(n))), t.and, true)}` : ''
    const pages = item.page ? `, ${pageRange(esc(item.page))}` : ''
    return `${chicagoTitle(p)} ${period(`${t.in} ${italic(p.container)}${eds}${pages}`)} ${period(placeText(item))}`
  },
  web: p => join([chicagoTitle(p), p.container ? period(p.container) : ''], ' '),
  thesis: p => join([chicagoTitle(p), period(join([genreText(p.item, p.t), esc(p.item.publisher)], ', '))], ' '),
  book: p => join([period(italic(p.title)), period(editionText(p.item, p.t)), period(placeText(p.item))], ' '),
  report: p => join([period(italic(p.title)), period(editionText(p.item, p.t)), period(placeText(p.item))], ' ')
}

function chicagoEntry(item: CslItem, ctx: FormatContext): string {
  const p = partsOf(item, ctx)
  const { role } = primaryNames(item)
  let who = p.names.length ? chicagoNames(p.names, p.t) : ''
  if (role === 'editor') who += `, ${editorTerm(p.names.length, p.t)}`
  const head = who ? `${period(who)} ${period(yearText(item, ctx))}` : ''
  const link = doiOrUrl(item)
  return join([head, CHICAGO_BODY[p.shape](p).trim(), link ? period(link) : ''], ' ')
}

// Harvard (Cite Them Right)

function harvardNames(names: CslName[], t: CitationTerms): string {
  const list = names.map(n => esc(invertedInitials(n)))
  if (list.length >= 4) return `${list[0]} ${t.etAl}`
  return andList(list, t.and, false)
}

function harvardAvailable(item: CslItem, ctx: FormatContext): string {
  const t = ctx.terms
  if (item.DOI) return `${t.availableAt}: ${doiUrl(item)}`
  if (!item.URL) return ''
  const accessed = item.accessed ? ` (${t.accessed}: ${longDate(item.accessed, ctx.locale)})` : ''
  return `${t.availableAt}: ${linkUrl(item.URL)}${accessed}`
}

function harvardBook(p: EntryParts): string {
  const { item, t } = p
  const thesis = p.shape === 'thesis'
  // Cite Them Right abbreviates "edition" as "edn".
  const edition = t.edition === 'ed.' ? editionText(item, t).replace(/ ed\.$/, ' edn') : editionText(item, t)
  const hasNames = p.names.length > 0
  return sentences([hasNames ? italic(p.title) : '', thesis ? join([genreText(item, t), esc(item.publisher)], '. ') : '', edition, thesis ? '' : placeText(item)])
}

const HARVARD_BODY: BodyTable<string> = {
  article: (p) => {
    const { item } = p
    const vi = esc(item.volume) + (item.issue ? `(${esc(item.issue)})` : '')
    return `${singleQuoted(p.title)}, ${join([italic(p.container), vi, item.page ? pagesText(item.page, p.t) : ''], ', ')}`
  },
  chapter: (p) => {
    const { item, t } = p
    const eds = item.editor?.length ? `${harvardNames(item.editor, t)} (${editorTerm(item.editor.length, t)}) ` : ''
    return `${singleQuoted(p.title)}, ${t.in.toLowerCase()} ${eds}${italic(p.container)}. ${join([placeText(item), item.page ? pagesText(item.page, t) : ''], ', ')}`
  },
  web: p => sentences([italic(p.title), p.container]),
  thesis: harvardBook,
  book: harvardBook,
  report: harvardBook
}

function harvardEntry(item: CslItem, ctx: FormatContext): string {
  const p = partsOf(item, ctx)
  const { role } = primaryNames(item)
  let who = p.names.length ? harvardNames(p.names, p.t) : ''
  if (role === 'editor') who += ` (${editorTerm(p.names.length, p.t)})`
  const head = `${who || italic(p.title)} (${yearText(item, ctx)})`
  const available = harvardAvailable(item, ctx)
  return join([head, period(HARVARD_BODY[p.shape](p)), available ? period(available) : ''], ' ')
}

// IEEE

function ieeeNames(names: CslName[], t: CitationTerms): string {
  const first = names[0]
  if (names.length > 6 && first) return `${esc(initialsFirst(first))} ${t.etAl}`
  const list = names.map(n => esc(initialsFirst(n)))
  return list.length === 2 ? `${list[0]} ${t.and} ${list[1]}` : andList(list, t.and, true)
}

function ieeeDate(item: CslItem, ctx: FormatContext): string {
  const long = longDate(item.issued, ctx.locale, 'short')
  return (/^\d{4}$/.test(long) ? '' : long) || String(issuedYear(item) ?? '')
}

/** `“Title,”` in the document's quotes (comma inside, IEEE). */
const ieeeTitleComma = (p: EntryParts) => quoted(`${p.title},`, p.ctx.locale)

function ieeeBook(p: EntryParts): string {
  return period(sentences([join([italic(p.title), editionText(p.item, p.t)], ', '), join([placeText(p.item), ieeeDate(p.item, p.ctx)], ', ')]))
}

const IEEE_BODY: BodyTable<string> = {
  article: (p) => {
    const { item, t } = p
    return period(join([
      `${ieeeTitleComma(p)} ${italic(p.container)}`,
      item.volume ? `${t.volume} ${esc(item.volume)}` : '',
      item.issue ? `${t.issue} ${esc(item.issue)}` : '',
      item.page ? pagesText(item.page, t) : '',
      ieeeDate(item, p.ctx),
      item.DOI ? `doi: ${esc(item.DOI)}` : ''
    ], ', '))
  },
  chapter: (p) => {
    const { item, t } = p
    return period(join([`${ieeeTitleComma(p)} ${t.in.toLowerCase()} ${italic(p.container)}`, placeText(item), ieeeDate(item, p.ctx), item.page ? pagesText(item.page, t) : '', item.DOI ? `doi: ${esc(item.DOI)}` : ''], ', '))
  },
  web: (p) => {
    const { item, t } = p
    const accessed = item.accessed ? period(`${t.accessed}: ${longDate(item.accessed, p.ctx.locale, 'short')}`) : ''
    return join([period(join([quotedTitle(p), p.container], ' ')), accessed, item.URL ? `[Online]. Available: ${linkUrl(item.URL)}` : ''], ' ')
  },
  thesis: p => period(join([quotedTitle(p), genreText(p.item, p.t), esc(p.item.publisher), ieeeDate(p.item, p.ctx)], ', ')),
  book: ieeeBook,
  report: ieeeBook
}

function ieeeEntry(item: CslItem, ctx: FormatContext): string {
  const p = partsOf(item, ctx)
  const { role } = primaryNames(item)
  let who = p.names.length ? ieeeNames(p.names, p.t) : ''
  if (role === 'editor') who += `, ${editorTerm(p.names.length, p.t)}`
  const online = p.shape === 'web' || !item.URL || item.DOI ? '' : `[Online]. Available: ${linkUrl(item.URL)}`
  return join([who ? `${who},` : '', IEEE_BODY[p.shape](p), online], ' ')
}

// Vancouver

function vancouverNames(names: CslName[], t: CitationTerms): string {
  const shown = names.slice(0, 6).map(n => esc(n.literal ?? join([family(n), initials(n.given, true)], ' ')))
  return shown.join(', ') + (names.length > 6 ? `, ${t.etAl}` : '')
}

const vancouverEditors = (count: number) => (count > 1 ? 'editors' : 'editor')

function vancouverBook(p: EntryParts): string {
  const { item, t } = p
  const place = placeText(item)
  const year = yearText(item, p.ctx)
  const thesis = p.shape === 'thesis' ? ` [${genreText(item, t)}]` : ''
  return join([period(p.title + thesis), period(editionText(item, t)), `${place}${place ? '; ' : ''}${year}.`], ' ')
}

const VANCOUVER_BODY: BodyTable<string> = {
  article: (p) => {
    const { item } = p
    const container = esc(item['container-title-short'] ?? item['container-title'])
    const vi = join([esc(item.volume), item.issue ? `(${esc(item.issue)})` : ''], '')
    return `${period(p.title)} ${period(container)} ${yearText(item, p.ctx)}${vi ? `;${vi}` : ''}${item.page ? `:${pageRange(esc(item.page))}` : ''}.`
  },
  chapter: (p) => {
    const { item, t } = p
    const container = esc(item['container-title-short'] ?? item['container-title'])
    const eds = item.editor?.length ? `${vancouverNames(item.editor, t)}, ${vancouverEditors(item.editor.length)}. ` : ''
    const pages = item.page ? ` p. ${pageRange(esc(item.page))}.` : ''
    return `${period(p.title)} ${t.in}: ${eds}${period(container)} ${placeText(item)}; ${yearText(item, p.ctx)}.${pages}`
  },
  web: (p) => {
    const { item } = p
    const container = esc(item['container-title-short'] ?? item['container-title'])
    const cited = item.accessed ? ` [cited ${longDate(item.accessed, 'en', 'short')}]` : ''
    const url = item.URL ? ` Available from: ${linkUrl(item.URL)}` : ''
    return `${p.title} [Internet]. ${container ? `${container}; ` : ''}${yearText(item, p.ctx)}${cited}.${url}`
  },
  thesis: vancouverBook,
  book: vancouverBook,
  report: vancouverBook
}

function vancouverEntry(item: CslItem, ctx: FormatContext): string {
  const p = partsOf(item, ctx)
  const { role } = primaryNames(item)
  let who = p.names.length ? vancouverNames(p.names, p.t) : ''
  if (role === 'editor') who += `, ${vancouverEditors(p.names.length)}`
  const doi = item.DOI ? ` doi:${esc(item.DOI)}` : ''
  return `${who ? `${period(who)} ` : ''}${VANCOUVER_BODY[p.shape](p)}${doi}`
}

// DIN 1505-2

function dinNames(names: CslName[]): string {
  const shown = names.length > 3 ? names.slice(0, 1) : names
  const list = shown.map(n => (n.literal ? esc(n.literal) : `${smallCaps(esc(family(n)))}${n.given ? `, ${esc(givenNames(n))}` : ''}`))
  return list.join(' ; ') + (names.length > 3 ? ` ; ${DIN_ET_AL}` : '')
}

const dinPages = (item: CslItem) => (item.page ? `S.${NBSP}${pageRange(esc(item.page))}` : '')

function dinBook(p: EntryParts): string {
  const { item, t } = p
  const year = yearText(item, p.ctx)
  const thesis = p.shape === 'thesis'
  return sentences([p.title, thesis ? join([genreText(item, t), esc(item.publisher)], ', ') : '', editionText(item, t), thesis ? year : join([placeText(item, ' : '), year], ', ')])
}

const DIN_BODY: BodyTable<string> = {
  article: (p) => {
    const { item, t } = p
    const pages = dinPages(item)
    const volume = item.volume ? ` ${t.volume} ${esc(item.volume)}` : ''
    const issue = item.issue ? `, ${t.issue} ${esc(item.issue)}` : ''
    return `${p.title}. ${t.in}: ${p.container}${volume} (${yearText(item, p.ctx)})${issue}${pages ? `, ${pages}` : ''}`
  },
  chapter: (p) => {
    const { item, t } = p
    const pages = dinPages(item)
    const eds = item.editor?.length ? `${dinNames(item.editor)} (${t.editor[0]}): ` : ''
    return `${p.title}. ${t.in}: ${eds}${p.container}. ${join([placeText(item, ' : '), yearText(item, p.ctx)], ', ')}${pages ? `, ${pages}` : ''}`
  },
  web: (p) => {
    const { item, t } = p
    return sentences([p.title, p.container, item.URL ? linkUrl(item.URL) : '', item.accessed ? `${t.accessed.toLowerCase()} ${longDate(item.accessed, 'de')}` : ''])
  },
  thesis: dinBook,
  book: dinBook,
  report: dinBook
}

function dinEntry(item: CslItem, ctx: FormatContext): string {
  const p = partsOf(item, ctx)
  const { role } = primaryNames(item)
  let who = p.names.length ? dinNames(p.names) : ''
  if (role === 'editor') who += ` (${p.t.editor[0]})`
  const doi = item.DOI ? ` – ${doiUrl(item)}` : ''
  return `${who ? `${who}: ` : ''}${DIN_BODY[p.shape](p)}${doi}`
}

const ENTRY_FORMATS: Record<FormatContext['style'], (item: CslItem, ctx: FormatContext) => string> = {
  'apa': apaEntry,
  'chicago-author-date': chicagoEntry,
  'harvard': harvardEntry,
  'ieee': ieeeEntry,
  'vancouver': vancouverEntry,
  'din-1505-2': dinEntry
}

/** One bibliography entry (inner HTML, without the number label of numeric styles). */
export function formatEntry(item: CslItem, ctx: FormatContext): string {
  return ENTRY_FORMATS[ctx.style](item, ctx)
}
