import type { DocTheme } from '../types/theme'
import { buildCoverHtml } from '../../app/utils/coverHtml'
import { wrapFirstLetterAsDropCap } from '../../app/utils/dropcapWrap'

/**
 * Combine the cover page + body markdown render + optional drop-cap
 * wrapping into the final HTML string that paged.js paginates.
 *
 * Three pipelines used to call `buildCoverHtml` + `wrapFirstLetterAsDropCap`
 * inline:
 *   - `usePagedPreview` — live editor preview iframe
 *   - `printPdf` — in-browser Print / Cmd+P flow
 *   - `app/pages/_internal/render/[docId].vue` — server-rendered PDF page
 *
 * Centralising the composition guarantees the three outputs stay
 * byte-identical: change the cover layout once, every consumer picks it
 * up. If you find yourself reaching for `buildCoverHtml(...)` directly
 * in any of those three call sites, route through this helper instead.
 *
 * Argument shape: `bodyHtml` is the OUTPUT of `renderMarkdown` (already
 * mermaid-transformed if appropriate). `dateIso` is the runtime date
 * string used by the cover's "Date" line. Returns an HTML string that's
 * ready to drop into paged.js's Previewer.preview() call.
 *
 * Cover-first ordering is deliberate: drop-cap matches the first body
 * `<p>` via regex; running it AFTER cover injection means it skips past
 * the cover (h1/divs) and lands on the actual first paragraph. Reversing
 * this order would put the drop-cap on the cover subtitle.
 */
export function composeFinalHtml(opts: {
  theme: DocTheme
  title: string
  dateIso: string
  bodyHtml: string
}): string {
  const { theme, title, dateIso, bodyHtml } = opts
  const coverHtml = buildCoverHtml(theme, title || '', dateIso)
  let html = coverHtml + bodyHtml
  if (theme.body.dropCap) {
    html = wrapFirstLetterAsDropCap(html)
  }
  return html
}
