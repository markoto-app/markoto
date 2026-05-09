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
 * Edge cases honored:
 *   - HTML starts with non-`<p>` (heading/blockquote/image): the regex
 *     finds the FIRST `<p>` regardless of position. The cover section
 *     prepended by `buildCoverHtml` uses `<h1>`/`<div>`, never `<p>`,
 *     so the wrap correctly skips past the cover to the body's first
 *     paragraph.
 *   - Leading whitespace inside the `<p>`: skipped before the wrap so
 *     the cap is the first non-space glyph.
 *   - Empty paragraph (`<p></p>`): no wrap.
 *   - First "letter" is a multibyte character (emoji, CJK, surrogate
 *     pair): we wrap one full code point via `Array.from`.
 *   - No `<p>` in the input at all: returned unchanged.
 *   - First `<p>` has attributes (e.g. `<p class="text-center">`):
 *     attributes are preserved in the wrapped output.
 */
export function wrapFirstLetterAsDropCap(html: string): string {
  const match = html.match(/<p(\s[^>]*)?>([\s\S]*?)<\/p>/i)
  if (!match) return html
  const [full, attrs = '', inner] = match
  if (!inner) return html
  const leading = /^\s*/.exec(inner)?.[0] ?? ''
  const rest = inner.slice(leading.length)
  if (!rest) return html
  // `Array.from` iterates by code point so surrogate pairs (emoji, some
  // CJK) get treated as one character — without this, slice(0, 1) would
  // split a 2-unit code point and produce an invalid leading char.
  const chars = Array.from(rest)
  if (chars.length === 0) return html
  const first = chars[0]!
  const tail = rest.slice(first.length)
  const wrapped = `<p${attrs}>${leading}<span class="markoto-dropcap">${first}</span>${tail}</p>`
  return html.replace(full, wrapped)
}
