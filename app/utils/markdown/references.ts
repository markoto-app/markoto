/**
 * The reference list of a document, as plain portable Markdown: the
 * section headed "References" (any level; also Bibliography / Literatur /
 * Références / Referencias / 参考文献 …, `REFERENCE_HEADINGS`). Its lists
 * and paragraphs get the class `markoto-references`, set by the engine
 * (`composeFinalHtml`) instead of an `{.references}` the author would have
 * to add. A class on the elements themselves survives pagination: paged.js
 * continues a split list or paragraph in a clone that keeps its
 * attributes, while a selector like `#references ~ ol` stops matching on
 * the next page or column (the heading is no longer a sibling there).
 * Styled by themeToCss `referencesBlock` (`blocks.referenceStyle`) and by
 * template CSS.
 *
 * The section runs from the heading to the next heading of the same or a
 * higher level (or the end). Works on parsed DOM (inert `<template>`) of
 * sanitised markup; the composed result is sanitised again. Browser-only.
 */
import { headingKey } from '~/utils/markdown/trimTrailing'

/** Heading texts recognised as a reference list (lower case, trailing colon/period ignored). */
const REFERENCE_HEADINGS: ReadonlySet<string> = new Set([
  'references', 'reference list', 'bibliography', 'works cited', 'literature', 'literature cited', 'sources',
  'literatur', 'literaturverzeichnis', 'quellen', 'quellenverzeichnis', 'referenzen', 'bibliographie',
  'références', 'références bibliographiques',
  'referencias', 'bibliografía', 'referencias bibliográficas',
  'riferimenti', 'riferimenti bibliografici', 'bibliografia',
  'referências', 'referências bibliográficas',
  'referenties', 'literatuurlijst',
  '参考文献', '参考資料', '引用文献'
])

const REFERENCES_CLASS = 'markoto-references'
export const REFERENCES_HEADING_CLASS = 'markoto-references-heading'

const HEADING = /^H([1-6])$/
const ENTRY_TAGS = new Set(['OL', 'UL', 'P'])

export function headingLevel(el: Element): number {
  const m = HEADING.exec(el.tagName)
  return m ? Number(m[1]) : 0
}

export function isReferencesHeading(el: Element): boolean {
  return REFERENCE_HEADINGS.has(headingKey(el))
}

/** Mark the reference sections' lists and paragraphs (top-level children only). */
export function markReferences(bodyHtml: string): string {
  const tpl = document.createElement('template')
  tpl.innerHTML = bodyHtml
  const root = tpl.content
  let marked = false
  for (const heading of Array.from(root.children)) {
    const lvl = headingLevel(heading)
    if (lvl === 0 || !isReferencesHeading(heading)) continue
    heading.classList.add(REFERENCES_HEADING_CLASS)
    marked = true
    for (let n = heading.nextElementSibling; n; n = n.nextElementSibling) {
      const l = headingLevel(n)
      if (l > 0 && l <= lvl) break
      if (ENTRY_TAGS.has(n.tagName)) n.classList.add(REFERENCES_CLASS)
    }
  }
  if (!marked) return bodyHtml
  const wrap = document.createElement('div')
  wrap.append(root)
  return wrap.innerHTML
}
