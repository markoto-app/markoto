/**
 * Wraps the first letter of the first `<p>` in rendered HTML with
 * `<span class="markoto-dropcap">…</span>` so theme CSS can style the
 * drop cap without relying on `::first-letter`.
 *
 * Why span instead of pseudo-element: paged.js's CSSTree-based polisher
 * silently strips rules with pseudo-element selectors (`::first-letter`,
 * `::footnote-call`, etc.) it doesn't whitelist. A class selector on a
 * real `<span>` survives the polisher's pass and renders identically.
 *
 * Works on PARSED HTML (an inert `<template>`), never on the string: the
 * input is sanitised markup, and splitting it with regexes could cut a
 * tag in half and turn attribute text into markup. Only a text node's
 * first code point is ever moved into the span.
 *
 * Edge cases honored:
 *   - HTML starts with non-`<p>` (heading/blockquote/image): the FIRST
 *     `<p>` in document order is used. The cover section prepended by
 *     `buildCoverHtml` uses `<h1>`/`<div>`, never `<p>`, so the wrap
 *     skips past the cover to the body's first paragraph.
 *   - Leading whitespace inside the `<p>`: skipped, the cap is the first
 *     non-space glyph.
 *   - Paragraph starting with an inline element (`<strong>`, `<a>`, …):
 *     the cap is that element's first letter. One starting with an image
 *     or line break gets no cap.
 *   - Empty / whitespace-only paragraph, no `<p>` at all, or already
 *     wrapped: returned unchanged (the input string itself).
 *   - Opening paragraph shorter than DROPCAP_MIN_CHARS, containing a
 *     hard line break, or starting inside `<strong>`/`<b>`/`<code>`:
 *     no cap (see DROPCAP_MIN_CHARS).
 *   - The capped paragraph gets DROPCAP_PARAGRAPH_CLASS so the theme CSS
 *     can contain the float (`display: flow-root`).
 *   - Only a LETTER becomes a cap: a paragraph that opens with a digit
 *     ("1817 presented …" would read as a giant "1" before "817"),
 *     a quotation mark, a bracket or an emoji gets none. `::first-letter`
 *     can't test for that, one more reason for the span.
 *   - Multibyte first letter (CJK, surrogate pair): one full code point
 *     via `Array.from`.
 *   - Browser-only (needs `document`); all callers run client-side.
 */

/**
 * Paragraphs inside these are not the body's opening prose: an alert's
 * title ("Tip") or a quote, list item, table cell or caption must never
 * get the drop cap (an alert would show a giant "T" in front of "IP").
 */
const NOT_BODY_PROSE = 'blockquote, .markdown-alert, li, td, th, figure, figcaption, aside, dl, .footnote, .markoto-cover'

const DESCEND_INTO = new Set(['a', 'abbr', 'b', 'code', 'del', 'em', 'i', 'ins', 'mark', 's', 'span', 'strong', 'sub', 'sup', 'u'])

const TEXT_NODE = 3
const ELEMENT_NODE = 1

function firstTextNode(parent: Node): Text | null {
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === TEXT_NODE) {
      if (child instanceof Text && (child.data.trim() !== '')) return child
      continue
    }
    if (child.nodeType !== ELEMENT_NODE || !(child instanceof Element)) continue
    if (child.classList.contains('markoto-dropcap')) return null
    return DESCEND_INTO.has(child.tagName.toLowerCase()) ? firstTextNode(child) : null
  }
  return null
}

/**
 * A drop cap is ~3.4em tall, about three body lines. Next to a shorter
 * opening paragraph (a short intro line, an AI-written one-liner) it
 * towers over the text and its float drags the following paragraph up
 * beside it. Below this length (about three lines of body text on an A4
 * page) the paragraph gets no cap.
 */
export const DROPCAP_MIN_CHARS = 220

/** Class on the paragraph that holds the cap; theme CSS makes it contain the float. */
const DROPCAP_PARAGRAPH_CLASS = 'markoto-dropcap-p'

/** Labels ("**Date:** …") and inline-formatted openers aren't prose to decorate. */
const NO_CAP_INSIDE = new Set(['b', 'strong', 'code'])

/** One code point that is a letter in any script. */
const LETTER = /^\p{L}$/u

export function wrapFirstLetterAsDropCap(html: string): string {
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  const p = Array.from(tpl.content.querySelectorAll('p')).find(el => !el.closest(NOT_BODY_PROSE)) ?? null
  if (!p || !capParagraph(p)) return html
  return tpl.innerHTML
}

/**
 * Put the drop cap on `p` (in place) when it qualifies, see the rules
 * above. Returns whether it did. Shared with the every-chapter drop cap
 * (`documentMarkers.ts#markDocumentStructure`).
 */
export function capParagraph(p: Element): boolean {
  // Only real opening prose: long enough to sit beside the cap, and not a
  // block of hard-broken lines (metadata like Date / Attendees).
  if ((p.textContent ?? '').trim().length < DROPCAP_MIN_CHARS) return false
  if (p.querySelector('br')) return false
  const text = firstTextNode(p)
  if (!text) return false
  if (text.parentElement && text.parentElement !== p && NO_CAP_INSIDE.has(text.parentElement.tagName.toLowerCase())) return false
  const leading = /^\s*/.exec(text.data)?.[0] ?? ''
  const rest = text.data.slice(leading.length)
  const first = Array.from(rest)[0]
  if (!first || !LETTER.test(first)) return false

  const doc = text.ownerDocument
  const span = doc.createElement('span')
  span.className = 'markoto-dropcap'
  span.textContent = first
  const tail = doc.createTextNode(rest.slice(first.length))
  text.data = leading
  text.after(span, tail)
  if (leading === '') text.remove()
  p.classList.add(DROPCAP_PARAGRAPH_CLASS)
  return true
}
