/**
 * The abstract of a paper, as plain portable Markdown: a section whose
 * heading is "Abstract" (any level, in one of the UI languages), placed
 * before every other heading — usually the first thing in the document:
 *
 *     ## Abstract
 *
 *     We measure …
 *
 *     # Introduction
 *
 * Any Markdown renderer shows that as a normal section, so the file stays
 * portable and the document model is unchanged (no theme or ymeta field
 * holds prose). With `cover.layout: 'title-block'` the section moves into
 * the title block at the top of page 1 (`extractAbstract`); with every
 * other layout it stays in place and is only marked (`markAbstract`) so
 * heading numbers skip it.
 *
 * The section runs from the heading to the next heading of the same or a
 * higher level (or the end). Its TOC entry is dropped (title block) or
 * marked (`markoto-abstract-entry`, not numbered).
 *
 * Works on parsed DOM (inert `<template>`) of sanitised markup; the
 * composed result is sanitised again by `composeFinalHtml`. Browser-only.
 */

/** Heading texts recognised as an abstract (lower case, trailing colon/period ignored). */
const ABSTRACT_HEADINGS: ReadonlySet<string> = new Set([
  'abstract', 'zusammenfassung', 'kurzfassung', 'résumé', 'resume', 'resumen', 'riassunto',
  '概要', '要旨', '摘要', '内容提要'
])

export const ABSTRACT_HEADING_CLASS = 'markoto-abstract-heading'
const ABSTRACT_ENTRY_CLASS = 'markoto-abstract-entry'
/** Pandoc's class for a heading without a number (`# References {.unnumbered}`, or `{-}`). */
export const UNNUMBERED_CLASS = 'unnumbered'
const UNNUMBERED_ENTRY_CLASS = 'markoto-unnumbered-entry'

const HEADING = /^H([1-6])$/

function headingLevel(el: Element): number {
  const m = HEADING.exec(el.tagName)
  return m ? Number(m[1]) : 0
}

function isAbstractHeading(el: Element): boolean {
  const text = (el.textContent ?? '').trim().toLowerCase().replace(/[:.：。]+$/u, '').trim()
  return ABSTRACT_HEADINGS.has(text)
}

/** The leading abstract heading among the top-level children, or null. */
function findAbstract(root: DocumentFragment): Element | null {
  for (const el of Array.from(root.children)) {
    if (headingLevel(el) === 0) continue
    return isAbstractHeading(el) ? el : null
  }
  return null
}

function tocEntriesFor(root: DocumentFragment, id: string): Element[] {
  if (!id) return []
  return Array.from(root.querySelectorAll('.table-of-contents a[href]'))
    .filter(a => a.getAttribute('href') === `#${id}`)
    .map(a => a.closest('li'))
    .filter((li): li is HTMLLIElement => li !== null)
}

function parse(html: string): DocumentFragment {
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  return tpl.content
}

function serialize(root: DocumentFragment): string {
  const wrap = document.createElement('div')
  wrap.append(root)
  return wrap.innerHTML
}

/**
 * Take the leading abstract section out of `bodyHtml`. Returns the
 * section's HTML for the title block (heading turned into a plain
 * `markoto-abstract-title` line, so it is neither numbered nor a heading
 * on page 1 twice) and the body without it. No abstract → unchanged body,
 * empty `abstractHtml`.
 */
export function extractAbstract(bodyHtml: string): { abstractHtml: string, bodyHtml: string } {
  const root = parse(bodyHtml)
  const heading = findAbstract(root)
  if (!heading) return { abstractHtml: '', bodyHtml }
  const level = headingLevel(heading)
  const parts: Element[] = []
  for (let n = heading.nextElementSibling; n; n = n.nextElementSibling) {
    const l = headingLevel(n)
    if (l > 0 && l <= level) break
    parts.push(n)
  }
  for (const li of tocEntriesFor(root, heading.id)) li.remove()
  const title = document.createElement('div')
  title.className = 'markoto-abstract-title'
  title.textContent = (heading.textContent ?? '').trim().replace(/[:：]$/u, '')
  const section = document.createDocumentFragment()
  section.append(title, ...parts)
  heading.remove()
  return { abstractHtml: serialize(section), bodyHtml: serialize(root) }
}

/** Mark the leading abstract heading + its TOC entry (layouts other than the title block). */
export function markAbstract(bodyHtml: string): string {
  const root = parse(bodyHtml)
  const heading = findAbstract(root)
  if (!heading) return bodyHtml
  heading.classList.add(ABSTRACT_HEADING_CLASS)
  for (const li of tocEntriesFor(root, heading.id)) li.classList.add(ABSTRACT_ENTRY_CLASS)
  return serialize(root)
}

/**
 * Mark the TOC entries of `{.unnumbered}` headings so the TOC numbers
 * skip them like the headings do (themeToCss `numberingBlock`). Only the
 * entry's own `li` — numbered sub-headings under it keep their numbers.
 */
export function markUnnumbered(bodyHtml: string): string {
  if (!bodyHtml.includes(UNNUMBERED_CLASS)) return bodyHtml
  const root = parse(bodyHtml)
  const headings = Array.from(root.querySelectorAll(`.${UNNUMBERED_CLASS}`)).filter(el => headingLevel(el) > 0)
  if (headings.length === 0) return bodyHtml
  for (const heading of headings) {
    for (const li of tocEntriesFor(root, heading.id)) li.classList.add(UNNUMBERED_ENTRY_CLASS)
  }
  return serialize(root)
}

/** Title text for comparison: Unicode-normalised, whitespace collapsed, case folded. */
function normalisedTitle(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase()
}

/**
 * Title-block layouts set the document title themselves, so a document
 * whose text opens with `# <its title>` (the academic-paper template, and
 * how most people write a paper) would print the title twice. Drop that
 * leading h1 — and its TOC entry — when its text equals the title
 * (normalised: case, whitespace, Unicode form). A different first h1, or
 * anything before it, leaves the body unchanged.
 */
export function dropTitleHeading(bodyHtml: string, title: string): string {
  const wanted = normalisedTitle(title)
  if (!wanted) return bodyHtml
  const root = parse(bodyHtml)
  const first = root.firstElementChild
  if (!first || first.tagName !== 'H1') return bodyHtml
  if (normalisedTitle(first.textContent ?? '') !== wanted) return bodyHtml
  for (const li of tocEntriesFor(root, first.id)) li.remove()
  first.remove()
  return serialize(root)
}
