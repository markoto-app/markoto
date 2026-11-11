import { ABSTRACT_HEADING_CLASS, UNNUMBERED_CLASS } from './titleBlock'
import { numberingBaseClass, SECTION_LABEL_ATTR } from '~~/shared/utils/theme/themeToCss'
import type { HeadingNumbering } from '~~/shared/types/theme'

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
 * - With `sectionLabels` (the `header.sectionNumber` option, given the
 *   numbering style): `data-markoto-section` on every section heading —
 *   its number as the theme CSS prints it plus its title ("3 Procedures";
 *   unnumbered: the title). The `{section}` token reads it with `attr()`:
 *   paged.js `string-set` can't see a `::before` number.
 *
 * The abstract (`markoto-abstract-heading`) is not a section; unnumbered
 * headings (`{.unnumbered}`) are sections but don't set the numbering
 * base.
 */
export const SECTION_HEADING_CLASS = 'markoto-section-heading'
const FIRST_SECTION_CLASS = 'markoto-first-section'

const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6'

function level(el: Element): number {
  return Number(el.tagName.slice(1))
}

export function markHeadingStructure(bodyHtml: string, numbered: boolean, sectionLabels?: HeadingNumbering): string {
  const tpl = document.createElement('template')
  tpl.innerHTML = bodyHtml
  const headings = Array.from(tpl.content.querySelectorAll(HEADING_SELECTOR))
    .filter(h => !h.classList.contains(ABSTRACT_HEADING_CLASS))
  if (headings.length === 0) return bodyHtml
  const top = Math.min(...headings.map(level))
  const sections = headings.filter(h => level(h) === top)
  for (const h of sections) h.classList.add(SECTION_HEADING_CLASS)
  sections[0]?.classList.add(FIRST_SECTION_CLASS)
  const counted = headings.filter(h => level(h) <= 4 && !h.classList.contains(UNNUMBERED_CLASS))
  const base = counted.length ? Math.min(...counted.map(level)) : 1
  if (numbered && base > 1) {
    for (const h of counted) h.classList.add(numberingBaseClass(base))
  }
  if (sectionLabels !== undefined) {
    // Section headings are the highest level used; they carry a number
    // when that level is the numbering base and they aren't unnumbered.
    let n = 0
    for (const h of sections) {
      const title = (h.textContent ?? '').trim()
      const counts = numbered && sectionLabels !== 'none' && top === base && top <= 4 && !h.classList.contains(UNNUMBERED_CLASS)
      if (counts) n++
      h.setAttribute(SECTION_LABEL_ATTR, counts ? `${sectionNumberLabel(sectionLabels, n)} ${title}` : title)
    }
  }
  const wrap = document.createElement('div')
  wrap.append(tpl.content)
  return wrap.innerHTML
}

/** The top-level heading number as the theme CSS prints it (themeToCss `numberLabel`). */
export function sectionNumberLabel(style: HeadingNumbering, n: number): string {
  switch (style) {
    case 'decimal-dot': return `${n}.`
    case 'ieee': return `${toRoman(n)}.`
    case 'decimal-zero': return String(n).padStart(2, '0')
    default: return String(n)
  }
}

const ROMAN: ReadonlyArray<readonly [number, string]> = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]

function toRoman(n: number): string {
  let rest = n
  let out = ''
  for (const [value, digits] of ROMAN) {
    while (rest >= value) {
      out += digits
      rest -= value
    }
  }
  return out
}
