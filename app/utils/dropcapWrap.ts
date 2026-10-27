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
 *   - Multibyte first character (emoji, CJK, surrogate pair): one full
 *     code point via `Array.from`.
 *   - Browser-only (needs `document`); all callers run client-side.
 */

/** Inline elements we look inside for the first letter. */
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

export function wrapFirstLetterAsDropCap(html: string): string {
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  const p = tpl.content.querySelector('p')
  if (!p) return html
  const text = firstTextNode(p)
  if (!text) return html
  const leading = /^\s*/.exec(text.data)?.[0] ?? ''
  const rest = text.data.slice(leading.length)
  const first = Array.from(rest)[0]
  if (!first) return html

  const doc = text.ownerDocument
  const span = doc.createElement('span')
  span.className = 'markoto-dropcap'
  span.textContent = first
  const tail = doc.createTextNode(rest.slice(first.length))
  text.data = leading
  text.after(span, tail)
  if (leading === '') text.remove()
  return tpl.innerHTML
}
