/**
 * The DOM side of citations and cross-references (parsing:
 * `markdownCitations.ts`). Two passes, both run by `composeFinalHtml` on
 * parsed DOM (inert `<template>`) of sanitised markup; the composed
 * result is sanitised again. Browser-only.
 *
 * 1. `resolveCitations` (before the heading structure pass): formats every
 *    citation cluster in the document's style and language and places the
 *    bibliography: at `[[bibliography]]`, else under an empty
 *    "References" / "Literatur" … heading, else at the end under a new
 *    unnumbered heading. Only cited entries are listed.
 * 2. `resolveCrossrefs` (after heading structure and caption numbering):
 *    numbers labelled figures, tables and equations the way the theme
 *    prints captions, resolves `@fig:` / `@tbl:` / `@eq:` / `@sec:`
 *    references into linked text ("Figure 3", "Abbildung 3"), and fills
 *    `[[lof]]` / `[[lot]]`.
 *
 * Problems (a key not in the bibliography, an unknown or duplicate label)
 * get a visible marker in the output and are reported to the caller, which
 * lists them in the editor.
 */
import type { DocTheme } from '~~/shared/types/theme'
import type { CslItem } from '~~/shared/utils/citations/cslItem'
import { crossrefKind, type CiteRef, type CrossrefKind } from '~~/shared/utils/citations/citeSyntax'
import { formatBibliography, formatCluster, planBibliography, type CitationStyleId, type ClusterEntry } from '~~/shared/utils/citations/citationStyles'
import { referencesHeading } from '~~/shared/utils/citations/citationTerms'
import { crossrefAnchorId, crossrefText, listTitle } from '~~/shared/utils/citations/crossrefTerms'
import type { CaptionLabels } from '~~/shared/utils/documents/documentLocale'
import { headingNumbering, numberingDepth, resolveCaptions } from '~~/shared/utils/theme/themeOptions'
import { SECTION_HEADING_CLASS } from '~~/shared/utils/theme/themeToCss'
import { headingLevel, isReferencesHeading } from './references'
import { BIBLIOGRAPHY_SLOT_CLASS, CITE_CLASS, EQUATION_CLASS, LABEL_ATTR, LIST_SLOT_CLASS, type CiteData } from './markdownCitations'
import { ABSTRACT_HEADING_CLASS, UNNUMBERED_CLASS } from '../preview/titleBlock'
import { sectionNumberLabel } from '../preview/headingStructure'

export type ReferenceProblemKind = 'missing-citation' | 'missing-label' | 'duplicate-label'

export interface ReferenceProblem {
  kind: ReferenceProblemKind
  key: string
}

export interface CitationInputs {
  items: readonly CslItem[]
  style: CitationStyleId
}

export const BROKEN_REF_CLASS = 'markoto-broken-ref'
const BIBLIOGRAPHY_CLASS = 'markoto-bibliography'
const CAPTION_LABEL_CLASS = 'markoto-caption-label'
const XREF_CLASS = 'markoto-xref'

function parse(bodyHtml: string): HTMLTemplateElement {
  const tpl = document.createElement('template')
  tpl.innerHTML = bodyHtml
  return tpl
}

function serialize(tpl: HTMLTemplateElement): string {
  const wrap = document.createElement('div')
  wrap.append(tpl.content)
  return wrap.innerHTML
}

/** `data-cite` of a span, validated (authors can write the attribute by hand). */
function citeData(el: Element): CiteData | null {
  try {
    const raw: unknown = JSON.parse(el.getAttribute('data-cite') ?? '')
    if (!raw || typeof raw !== 'object') return null
    const { refs, bracketed } = raw as { refs?: unknown, bracketed?: unknown }
    if (!Array.isArray(refs) || refs.length === 0 || refs.length > 50) return null
    const clean: CiteRef[] = []
    for (const r of refs) {
      if (!r || typeof r !== 'object') return null
      const o = r as Record<string, unknown>
      if (typeof o.key !== 'string') return null
      const loc = o.locator as { label?: unknown, value?: unknown } | undefined
      clean.push({
        key: o.key.slice(0, 100),
        prefix: typeof o.prefix === 'string' ? o.prefix.slice(0, 200) : '',
        suffix: typeof o.suffix === 'string' ? o.suffix.slice(0, 200) : '',
        suppressAuthor: o.suppressAuthor === true,
        ...(loc && typeof loc.label === 'string' && typeof loc.value === 'string'
          ? { locator: { label: loc.label as NonNullable<CiteRef['locator']>['label'], value: loc.value.slice(0, 50) } }
          : {})
      })
    }
    return { refs: clean, bracketed: bracketed === true }
  } catch {
    return null
  }
}

function brokenMarker(doc: Document, text: string, key: string): HTMLElement {
  const span = doc.createElement('span')
  span.className = BROKEN_REF_CLASS
  span.setAttribute('data-markoto-missing', key)
  span.textContent = text
  return span
}

function fragment(doc: Document, html: string): DocumentFragment {
  const tpl = doc.createElement('template')
  tpl.innerHTML = html
  return tpl.content
}

/** Is the section under `heading` empty (next element is a heading of the same or a higher level, or nothing)? */
function sectionIsEmpty(heading: Element): boolean {
  const next = heading.nextElementSibling
  if (!next) return true
  const l = headingLevel(next)
  return l > 0 && l <= headingLevel(heading)
}

/**
 * Format citations and place the bibliography. `locale` is the document
 * locale (`documentTexts(...).locale`).
 */
export function resolveCitations(bodyHtml: string, citations: CitationInputs | null, locale: string): { html: string, problems: ReferenceProblem[] } {
  if (!bodyHtml.includes(CITE_CLASS) && !bodyHtml.includes(BIBLIOGRAPHY_SLOT_CLASS)) return { html: bodyHtml, problems: [] }
  const tpl = parse(bodyHtml)
  const root = tpl.content
  const doc = root.ownerDocument
  const byKey = new Map((citations?.items ?? []).map(item => [item.id, item]))
  const problems: ReferenceProblem[] = []
  const spans = Array.from(root.querySelectorAll(`span.${CITE_CLASS}`))
  // Pass A: what is cited, in order (numbering, disambiguation).
  const cited: CslItem[] = []
  const seen = new Set<string>()
  const parsed = spans.map((el) => {
    const data = citeData(el)
    if (!data || crossrefKind(data.refs[0]?.key ?? '')) return null
    for (const r of data.refs) {
      const item = byKey.get(r.key)
      if (item && !seen.has(item.id)) {
        seen.add(item.id)
        cited.push(item)
      }
    }
    return data
  })
  const plan = planBibliography(cited, citations?.style ?? 'apa', locale)
  // Pass B: text.
  spans.forEach((el, idx) => {
    const data = parsed[idx]
    if (!data) return
    const found: ClusterEntry[] = []
    const missing: string[] = []
    for (const ref of data.refs) {
      const item = byKey.get(ref.key)
      if (item) found.push({ item, ref })
      else missing.push(ref.key)
    }
    // A bare `@word` that names no entry is ordinary text (a handle, a mention).
    if (!data.bracketed && found.length === 0) {
      el.replaceWith(doc.createTextNode(el.textContent ?? ''))
      return
    }
    for (const key of missing) problems.push({ kind: 'missing-citation', key })
    const out = doc.createDocumentFragment()
    if (found.length > 0) out.append(fragment(doc, formatCluster(found, plan.ctx, !data.bracketed)))
    for (const key of missing) {
      if (out.childNodes.length > 0) out.append(doc.createTextNode(' '))
      out.append(brokenMarker(doc, `[@${key}?]`, key))
    }
    const span = doc.createElement('span')
    span.className = CITE_CLASS
    span.append(out)
    el.replaceWith(span)
  })

  const slots = Array.from(root.querySelectorAll(`div.${BIBLIOGRAPHY_SLOT_CLASS}`))
  if (cited.length > 0 || slots.length > 0) {
    const bib = doc.createElement('div')
    bib.className = BIBLIOGRAPHY_CLASS
    if (cited.length > 0) bib.append(fragment(doc, formatBibliography(plan)))
    const [slot, ...extra] = slots
    for (const s of extra) s.remove()
    const emptyHeading = Array.from(root.children).find(h => headingLevel(h) > 0 && isReferencesHeading(h) && sectionIsEmpty(h))
    if (slot) slot.replaceWith(bib)
    else if (emptyHeading) emptyHeading.after(bib)
    else {
      // A heading at the document's top section level, unnumbered.
      const levels = Array.from(root.children).map(headingLevel).filter(l => l > 0)
      const level = levels.length ? Math.min(...levels) : 2
      const heading = doc.createElement(`h${Math.min(level, 6)}`)
      heading.className = UNNUMBERED_CLASS
      heading.id = 'references'
      heading.textContent = referencesHeading(locale)
      root.append(heading, bib)
    }
  }
  return { html: serialize(tpl), problems }
}

// Cross-references

interface Target {
  kind: CrossrefKind
  el: Element
  /** Printed number ("3", "3.1", "(4)"), or '' for an unnumbered section. */
  number: string
  /** Section title, for unnumbered sections. */
  title?: string
}

/** Heading numbers as the theme prints them (numberingCss): label per heading element. */
function headingNumbers(root: DocumentFragment, theme: DocTheme): Map<Element, string> {
  const style = headingNumbering(theme)
  const out = new Map<Element, string>()
  if (style === 'none') return out
  const depth = numberingDepth(theme)
  const counted = Array.from(root.querySelectorAll('h1, h2, h3, h4'))
    .filter(h => !h.classList.contains(UNNUMBERED_CLASS) && !h.classList.contains(ABSTRACT_HEADING_CLASS))
  if (counted.length === 0) return out
  const base = Math.min(...counted.map(headingLevel))
  const counters = [0, 0, 0, 0, 0]
  for (const h of counted) {
    const l = headingLevel(h)
    counters[l] = (counters[l] ?? 0) + 1
    for (let k = l + 1; k <= 4; k++) counters[k] = 0
    if (l - base >= depth) continue
    const parts = counters.slice(base, l + 1)
    let label: string
    if (style === 'ieee') {
      label = parts.map((n, i) => (i === 0 ? sectionNumberLabel('ieee', n).replace(/\.$/, '') : i === 1 ? String.fromCodePoint(64 + n) : String(n))).join('-')
    } else if (style === 'decimal-zero') {
      label = parts.map((n, i) => (i === 0 ? String(n).padStart(2, '0') : String(n))).join('.')
    } else {
      label = parts.join('.')
    }
    out.set(h, label)
  }
  return out
}

/** Labels in the document (`{#fig:x}` ids, `{#sec:x}` heading labels); duplicates reported. */
function collectLabels(root: DocumentFragment, problems: ReferenceProblem[]): Map<string, Element> {
  const labels = new Map<string, Element>()
  for (const el of Array.from(root.querySelectorAll(`[id], [${LABEL_ATTR}]`))) {
    const id = el.getAttribute(LABEL_ATTR) ?? el.id
    if (!crossrefKind(id)) continue
    if (labels.has(id)) problems.push({ kind: 'duplicate-label', key: id })
    else labels.set(id, el)
  }
  return labels
}

interface Numbered { el: Element, number: string }

interface NumberingInput {
  doc: Document
  root: DocumentFragment
  labels: Map<string, Element>
  theme: DocTheme
  captionLabels: CaptionLabels
  /** `[[lof]]` / `[[lot]]` present. */
  lists: { lof: boolean, lot: boolean }
}

interface NumberingResult {
  targets: Map<string, Target>
  figures: Numbered[]
  tables: Numbered[]
}

/**
 * Walks figures, tables and labelled equations in document order and
 * numbers them like the theme prints captions (per chapter with
 * `blocks.captionNumbering: 'chapter'`).
 */
class CaptionNumberer {
  readonly result: NumberingResult = { targets: new Map(), figures: [], tables: [] }
  private chapter = 0
  private inChapter = false
  private counts = { fig: 0, tbl: 0, eq: 0 }
  private readonly chapterMode: boolean
  private readonly numberFigures: boolean
  private readonly numberTables: boolean
  private readonly labelFor = new Map<Element, string>()
  private readonly captions: ReturnType<typeof resolveCaptions>

  constructor(private readonly input: NumberingInput) {
    this.captions = resolveCaptions(input.theme)
    this.chapterMode = this.captions.numbering === 'chapter'
    const labelled = (k: CrossrefKind) => [...input.labels.keys()].some(l => crossrefKind(l) === k)
    // Which captions carry numbers: all, when the theme labels them or the
    // document refers to / lists them; CSS counters then count the same set.
    this.numberFigures = this.captions.figureLabel || labelled('fig') || input.lists.lof
    this.numberTables = this.captions.tableLabel || labelled('tbl') || input.lists.lot
    // The element a label names: a figure's label sits on its <img>.
    for (const [label, el] of input.labels) {
      this.labelFor.set(crossrefKind(label) === 'fig' ? (el.closest('figure') ?? el) : el, label)
    }
  }

  run(): NumberingResult {
    const ordered = this.input.root.querySelectorAll(`.${SECTION_HEADING_CLASS}, figure, table, div.${EQUATION_CLASS}, img[id^="fig:"]`)
    for (const el of Array.from(ordered)) this.visit(el)
    return this.result
  }

  private next(kind: 'fig' | 'tbl' | 'eq'): string {
    const n = ++this.counts[kind]
    return this.chapterMode && this.inChapter ? `${this.chapter}.${n}` : String(n)
  }

  private visit(el: Element): void {
    if (el.classList.contains(SECTION_HEADING_CLASS)) {
      this.inChapter = !el.classList.contains(UNNUMBERED_CLASS)
      if (this.inChapter) this.chapter++
      this.counts = { fig: 0, tbl: 0, eq: 0 }
      return
    }
    if (el.tagName === 'IMG' && el.closest('figure')) return
    const label = this.labelFor.get(el)
    if (el.tagName === 'FIGURE' || el.tagName === 'IMG') this.figure(el, label)
    else if (el.tagName === 'TABLE') this.table(el, label)
    else if (label) this.equation(el, label)
  }

  private figure(el: Element, label: string | undefined): void {
    const caption = el.tagName === 'FIGURE' ? el.querySelector(':scope > figcaption') : null
    if (!this.numberFigures || (!hasContent(caption) && !label)) return
    const number = this.next('fig')
    this.result.figures.push({ el, number })
    if (label) this.result.targets.set(label, { kind: 'fig', el, number })
    const { captionLabels: labels } = this.input
    labelCaption(this.input.doc, el, caption, this.captions.figureLabel, `${labels.figure} ${number}`, labels.separator)
  }

  private table(el: Element, label: string | undefined): void {
    const caption = el.querySelector(':scope > caption')
    if (!this.numberTables || (!hasContent(caption) && !label)) return
    const number = this.next('tbl')
    this.result.tables.push({ el, number })
    if (label) this.result.targets.set(label, { kind: 'tbl', el, number })
    const { captionLabels: labels } = this.input
    labelCaption(this.input.doc, el, caption, this.captions.tableLabel, `${labels.table} ${number}`, labels.separator)
  }

  private equation(el: Element, label: string): void {
    const number = `(${this.next('eq')})`
    el.setAttribute('data-markoto-number', number)
    this.result.targets.set(label, { kind: 'eq', el, number })
  }
}

function hasContent(el: Element | null): boolean {
  return !!el && el.childNodes.length > 0
}

/**
 * Ids without ':' (paged.js reads `#…` hrefs as selectors); links to the
 * old id (the TOC's, for a labelled heading) follow.
 */
function renameLabelIds(root: DocumentFragment, labels: Map<string, Element>, targets: Map<string, Target>): void {
  const renamed = new Map<string, string>()
  for (const [label, t] of targets) {
    // A labelled heading keeps its slug id (the TOC links to it).
    if (t.el.hasAttribute(LABEL_ATTR) && t.el.id) continue
    labels.get(label)?.removeAttribute('id')
    t.el.id = crossrefAnchorId(label)
    renamed.set(label, t.el.id)
  }
  for (const el of Array.from(root.querySelectorAll('[id]'))) {
    if (!crossrefKind(el.id)) continue
    // A duplicate or otherwise unused label.
    const id = `${crossrefAnchorId(el.id)}-unused`
    if (!renamed.has(el.id)) renamed.set(el.id, id)
    el.id = id
  }
  for (const a of Array.from(root.querySelectorAll('a[href^="#"]'))) {
    const next = renamed.get((a.getAttribute('href') ?? '').slice(1))
    if (next) a.setAttribute('href', `#${next}`)
  }
}

/** One `[[lof]]` / `[[lot]]` entry: linked label + caption text. */
function listEntry(doc: Document, kind: 'lof' | 'lot', entry: Numbered, idx: number, captionLabels: CaptionLabels): HTMLLIElement {
  const { el, number } = entry
  if (!el.id) el.id = `xref-${kind}-${idx + 1}`
  const caption = el.querySelector(kind === 'lof' ? ':scope > figcaption' : ':scope > caption')
  const li = doc.createElement('li')
  const a = doc.createElement('a')
  a.setAttribute('href', `#${el.id}`)
  const num = doc.createElement('span')
  num.className = 'markoto-list-number'
  num.textContent = `${kind === 'lof' ? captionLabels.figure : captionLabels.table} ${number}`
  const text = doc.createElement('span')
  text.className = 'markoto-list-text'
  const clone = caption?.cloneNode(true) as Element | undefined
  clone?.querySelectorAll(`.${CAPTION_LABEL_CLASS}`).forEach(n => n.remove())
  text.textContent = (clone?.textContent ?? '').trim()
  a.append(num, text)
  li.append(a)
  return li
}

function fillList(doc: Document, slot: Element, numbering: NumberingResult, locale: string, captionLabels: CaptionLabels): void {
  const kind = slot.getAttribute('data-markoto-list') === 'lot' ? 'lot' : 'lof'
  const entries = kind === 'lof' ? numbering.figures : numbering.tables
  const nav = doc.createElement('nav')
  nav.className = `markoto-list markoto-${kind}`
  const title = doc.createElement('div')
  title.className = 'markoto-list-title'
  title.textContent = listTitle(kind, locale)
  const ul = doc.createElement('ul')
  entries.forEach((entry, idx) => ul.append(listEntry(doc, kind, entry, idx, captionLabels)))
  nav.append(title, ul)
  slot.replaceWith(nav)
}

export function resolveCrossrefs(bodyHtml: string, theme: DocTheme, locale: string, captionLabels: CaptionLabels): { html: string, problems: ReferenceProblem[] } {
  const hasLabel = /(?:id|data-markoto-label)="(?:fig|tbl|eq|sec):/.test(bodyHtml)
  if (!hasLabel && !bodyHtml.includes(CITE_CLASS) && !bodyHtml.includes(LIST_SLOT_CLASS)) return { html: bodyHtml, problems: [] }
  const tpl = parse(bodyHtml)
  const root = tpl.content
  const doc = root.ownerDocument
  const problems: ReferenceProblem[] = []
  const labels = collectLabels(root, problems)
  const slots = Array.from(root.querySelectorAll(`nav.${LIST_SLOT_CLASS}`))
  const wantsList = (kind: 'lof' | 'lot') => slots.some(s => s.getAttribute('data-markoto-list') === kind)
  const numbering = new CaptionNumberer({ doc, root, labels, theme, captionLabels, lists: { lof: wantsList('lof'), lot: wantsList('lot') } }).run()
  const { targets } = numbering
  const sectionNumbers = headingNumbers(root, theme)
  for (const [label, el] of labels) {
    if (crossrefKind(label) !== 'sec') continue
    targets.set(label, { kind: 'sec', el, number: sectionNumbers.get(el) ?? '', title: (el.textContent ?? '').trim() })
  }
  renameLabelIds(root, labels, targets)
  for (const el of Array.from(root.querySelectorAll(`span.${CITE_CLASS}[data-cite]`))) {
    const data = citeData(el)
    const first = data?.refs[0]
    if (!data || !first || !crossrefKind(first.key)) continue
    el.replaceWith(renderXref(doc, data, targets, locale, captionLabels, problems))
  }
  for (const slot of slots) fillList(doc, slot, numbering, locale, captionLabels)
  return { html: serialize(tpl), problems }
}

/**
 * Caption label for a numbered figure / table: written by the theme CSS
 * when the label option is on (only the number attribute is needed for
 * chapter numbering), else inserted here so a referenced or listed figure
 * shows the number the text refers to.
 */
function labelCaption(doc: Document, owner: Element, caption: Element | null, cssLabels: boolean, label: string, separator: string): void {
  let cap = caption
  if (!cap) {
    // A labelled figure or table without caption text still shows its number.
    cap = doc.createElement(owner.tagName === 'TABLE' ? 'caption' : 'figcaption')
    if (owner.tagName === 'TABLE') owner.prepend(cap)
    else if (owner.tagName === 'FIGURE') owner.append(cap)
    else return
    if (cssLabels) {
      cap.textContent = '​'
      return
    }
  }
  const number = label.slice(label.lastIndexOf(' ') + 1)
  cap.setAttribute('data-markoto-number', number)
  if (cssLabels) return
  const span = doc.createElement('span')
  span.className = CAPTION_LABEL_CLASS
  span.textContent = cap.childNodes.length > 0 ? `${label}${separator}` : label
  cap.prepend(span)
}

function renderXref(doc: Document, data: CiteData, targets: Map<string, Target>, locale: string, captionLabels: CaptionLabels, problems: ReferenceProblem[]): DocumentFragment {
  const out = doc.createDocumentFragment()
  const prefix = data.refs[0]?.prefix ?? ''
  if (prefix) out.append(doc.createTextNode(`${prefix} `))
  // Consecutive refs of one kind share the word: "Figures 2 and 3".
  const groups: Array<{ kind: CrossrefKind, refs: Array<{ ref: CiteRef, target: Target | null }> }> = []
  for (const ref of data.refs) {
    const kind = crossrefKind(ref.key)
    const target = targets.get(ref.key) ?? null
    if (!kind || !target) {
      problems.push({ kind: 'missing-label', key: ref.key })
      groups.push({ kind: kind ?? 'sec', refs: [{ ref, target: null }] })
      continue
    }
    const last = groups.at(-1)
    if (last && last.kind === kind && last.refs.every(r => r.target)) last.refs.push({ ref, target })
    else groups.push({ kind, refs: [{ ref, target }] })
  }
  groups.forEach((g, gi) => {
    if (gi > 0) out.append(doc.createTextNode(', '))
    const first = g.refs[0]
    if (!first?.target) {
      out.append(brokenMarker(doc, `@${first?.ref.key ?? ''}?`, first?.ref.key ?? ''))
      return
    }
    const a = doc.createElement('a')
    a.className = XREF_CLASS
    a.setAttribute('href', `#${first.target.el.id}`)
    const unnumberedSection = g.kind === 'sec' && g.refs.some(r => !r.target?.number)
    if (unnumberedSection) {
      a.textContent = g.refs.map(r => r.target?.title ?? '').join(', ')
    } else {
      const word = g.kind === 'fig' ? captionLabels.figure : g.kind === 'tbl' ? captionLabels.table : undefined
      a.textContent = crossrefText(g.kind, g.refs.map(r => r.target?.number ?? ''), locale, word)
    }
    out.append(a)
  })
  const suffix = data.refs.at(-1)?.suffix ?? ''
  if (suffix) out.append(doc.createTextNode(`, ${suffix}`))
  return out
}
