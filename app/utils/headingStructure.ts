import { ABSTRACT_HEADING_CLASS, UNNUMBERED_CLASS } from './titleBlock'
import { numberingBaseClass } from '~~/shared/utils/themeToCss'

/**
 * Structural markers on the body's headings, for the theme CSS and for
 * template CSS (`composeFinalHtml`). Works on parsed DOM (inert
 * `<template>`) of sanitised markup; the composed result is sanitised
 * again. Browser-only.
 *
 * - `markoto-section-heading` on every heading of the highest level the
 *   document uses (h1, or h2 in a document without h1) — the `{section}`
 *   running-head token reads them (themeToCss `sectionStringBlock`).
 * - `markoto-first-section` on the first of them. paged.js clones the
 *   parents of a page's content onto every page, so `h1:first-of-type`
 *   in template CSS matches the first h1 of EVERY page; this class marks
 *   the document's first section only.
 * - With heading numbers on: `markoto-num-from-hN` on the numbered
 *   headings when the highest numbered level is h2–h4, so the numbers
 *   start at `1` there instead of `0.1` (themeToCss `numberingBlock`).
 *
 * The abstract (`markoto-abstract-heading`) is not a section; unnumbered
 * headings (`{.unnumbered}`) are sections but don't set the numbering
 * base.
 */
export const SECTION_HEADING_CLASS = 'markoto-section-heading'
export const FIRST_SECTION_CLASS = 'markoto-first-section'

const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6'

function level(el: Element): number {
  return Number(el.tagName.slice(1))
}

export function markHeadingStructure(bodyHtml: string, numbered: boolean): string {
  const tpl = document.createElement('template')
  tpl.innerHTML = bodyHtml
  const headings = Array.from(tpl.content.querySelectorAll(HEADING_SELECTOR))
    .filter(h => !h.classList.contains(ABSTRACT_HEADING_CLASS))
  if (headings.length === 0) return bodyHtml
  const top = Math.min(...headings.map(level))
  const sections = headings.filter(h => level(h) === top)
  for (const h of sections) h.classList.add(SECTION_HEADING_CLASS)
  sections[0]?.classList.add(FIRST_SECTION_CLASS)
  if (numbered) {
    const counted = headings.filter(h => level(h) <= 4 && !h.classList.contains(UNNUMBERED_CLASS))
    const base = counted.length ? Math.min(...counted.map(level)) : 1
    if (base > 1) {
      for (const h of counted) h.classList.add(numberingBaseClass(base))
    }
  }
  const wrap = document.createElement('div')
  wrap.append(tpl.content)
  return wrap.innerHTML
}
