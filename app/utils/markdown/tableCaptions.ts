/**
 * `tables.captionPosition: 'below'`: move every table's `<caption>` (first
 * child, as `renderMarkdown` writes it) to the END of the table. CSS
 * `caption-side: bottom` alone would draw it under the FIRST part of a
 * table that paged.js splits across pages; as the last child it goes with
 * the last part. HTML parsers keep a caption that follows the rows where
 * it is (a caption start tag inside the table appends to the table), so
 * the order survives the final sanitising pass and paged.js.
 * Browser-only (DOM).
 */
export function moveCaptionsBelow(bodyHtml: string): string {
  if (!bodyHtml.includes('<caption')) return bodyHtml
  const tpl = document.createElement('template')
  tpl.innerHTML = bodyHtml
  for (const caption of Array.from(tpl.content.querySelectorAll('table > caption'))) {
    caption.parentElement?.append(caption)
  }
  const wrap = document.createElement('div')
  wrap.append(tpl.content)
  return wrap.innerHTML
}
