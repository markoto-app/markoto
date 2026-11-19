import { issuedYear, type CslItem } from './cslItem'
import type { CiteRef } from './citeSyntax'
import { referenceAnchorId } from './crossrefTerms'
import {
  andList, esc, escapeHtml, family, formatContext, italic, join, locatorText, primaryNames, quoted,
  shapeOf, smallCaps, stripTags, styleKind, yearText, type CitationStyleId, type FormatContext
} from '../../citationFormat/format'
import { DIN_ET_AL, formatEntry } from '../../citationFormat/entries'

/**
 * The citation styles markoto formats, implemented here rather than
 * through a CSL processor (citeproc-js is CPAL/AGPL licensed; see
 * docs/contributing/citations.md). Each style follows its published
 * rules for the common item types (journal article, book, chapter,
 * conference paper, report, thesis, web page); other types fall back to
 * the book or web shape. Output is HTML built from escaped text only, and
 * is sanitised again with the rest of the document.
 */

export {
  CITATION_STYLE_IDS, CITATION_STYLES, DEFAULT_CITATION_STYLE, citationStyleOf, formatContext,
  initials, isCitationStyleId, styleKind
} from '../../citationFormat/format'
export type { CitationStyleId, CitationStyleInfo, FormatContext } from '../../citationFormat/format'
export { formatEntry } from '../../citationFormat/entries'

// In-text author part (author-date styles)

function titleInText(item: CslItem, ctx: FormatContext): string {
  const title = esc(item['title-short'] ?? item.title ?? '')
  const shape = shapeOf(item)
  return shape === 'book' || shape === 'report' || shape === 'thesis' ? italic(title) : quoted(title, ctx.locale)
}

function citeAuthors(item: CslItem, ctx: FormatContext, narrative: boolean): string {
  const { names } = primaryNames(item)
  if (names.length === 0) return titleInText(item, ctx)
  const t = ctx.terms
  const fam = names.map(n => esc(family(n)))
  const first = fam[0] ?? ''
  switch (ctx.style) {
    case 'apa':
      if (fam.length >= 3) return `${first} ${t.etAl}`
      return fam.length === 2 ? `${first} ${narrative ? t.and : '&amp;'} ${fam[1]}` : first
    case 'chicago-author-date':
      return fam.length >= 4 ? `${first} ${t.etAl}` : andList(fam, t.and, true)
    case 'harvard':
      return fam.length >= 4 ? `${first} ${t.etAl}` : andList(fam, t.and, false)
    case 'din-1505-2':
      return fam.length >= 3 ? `${smallCaps(first)} ${DIN_ET_AL}` : fam.map(smallCaps).join(' ; ')
    case 'ieee':
    case 'vancouver':
      return first
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

/** `[1, p. 3], [2]` (IEEE) or `(1 p. 3, 2)` (Vancouver); prefix of the first, suffix of the last entry. */
function numericCluster(entries: readonly ClusterEntry[], ctx: FormatContext): string {
  const t = ctx.terms
  const num = (e: ClusterEntry) => String(ctx.numbers.get(e.item.id) ?? '?')
  const firstRef = entries[0]?.ref
  const prefix = firstRef?.prefix ? `${esc(firstRef.prefix)} ` : ''
  const lastSuffix = entries.at(-1)?.ref.suffix
  const suffix = lastSuffix ? `, ${esc(lastSuffix)}` : ''
  if (ctx.style === 'ieee') {
    const parts = entries.map(e => anchor(e.item.id, `[${join([num(e), locatorText(e.ref.locator, t)], ', ')}]`))
    return `${prefix}${parts.join(', ')}${suffix}`
  }
  const parts = entries.map(e => anchor(e.item.id, join([num(e), locatorText(e.ref.locator, t)], ' ')))
  return `(${prefix}${parts.join(', ')}${suffix})`
}

function authorDateCluster(entries: readonly ClusterEntry[], ctx: FormatContext, narrative: boolean): string {
  const chicago = ctx.style === 'chicago-author-date'
  const yearAndLocator = (e: ClusterEntry) => join([yearText(e.item, ctx), locatorText(e.ref.locator, ctx.terms, chicago)], ', ')
  if (narrative) {
    return entries.map((e) => {
      const inner = join([e.ref.prefix ? esc(e.ref.prefix) : '', yearAndLocator(e)], ' ') + (e.ref.suffix ? `, ${esc(e.ref.suffix)}` : '')
      return anchor(e.item.id, `${citeAuthors(e.item, ctx, true)} (${inner})`)
    }).join('; ')
  }
  const sep = chicago || ctx.style === 'din-1505-2' ? ' ' : ', '
  const parts = entries.map((e) => {
    const body = e.ref.suppressAuthor ? yearAndLocator(e) : `${citeAuthors(e.item, ctx, false)}${sep}${yearAndLocator(e)}`
    return withAffixes(e.ref, anchor(e.item.id, body))
  })
  return `(${parts.join('; ')})`
}

/**
 * One citation cluster (`[@a; @b, p. 3]`) in `ctx.style`. `narrative`
 * for a bare `@key` in the running text ("Smith (2020)").
 */
export function formatCluster(entries: readonly ClusterEntry[], ctx: FormatContext, narrative: boolean): string {
  if (entries.length === 0) return ''
  return styleKind(ctx.style) === 'numeric' ? numericCluster(entries, ctx) : authorDateCluster(entries, ctx, narrative)
}

/** Sort key for author-date bibliographies: first name's family (without particle), year, title. */
function sortKey(item: CslItem): string {
  const names = primaryNames(item).names
  const first = names[0]
  const name = first ? (first.literal ?? join([first.family, first.given], ' ')) : (item.title ?? '')
  const all = names.map(n => n.family ?? n.literal ?? '').join(' ')
  return `${name}\u0000${all}\u0000${issuedYear(item) ?? 9999}\u0000${item.title ?? ''}`.toLocaleLowerCase()
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
  return stripTags(html).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'')
}

/** One entry as plain text in `style` (no year suffix or number). */
export function formatEntryText(item: CslItem, style: CitationStyleId, locale: string): string {
  return htmlToText(formatEntry(item, formatContext(style, locale)))
}
