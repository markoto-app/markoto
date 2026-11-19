/**
 * Accessibility fixes on the paginated DOM before the renderer prints a
 * tagged PDF. Chromium builds the PDF structure tree from the
 * accessibility tree, so these work through ARIA.
 *
 * - paged.js page furniture (margin boxes: running header and footer,
 *   page numbers) repeats on every page and would be read in the middle
 *   of the text: hidden from assistive technology, it stays out of the
 *   structure tree.
 * - Footnotes in the page's footnote area are `display: list-item` (the
 *   number is their list marker), which Chromium tags as a list item
 *   without a list. They are notes.
 */
export function prepareForTaggedPdf(root: ParentNode): void {
  for (const el of Array.from(root.querySelectorAll('.pagedjs_margin'))) {
    el.setAttribute('aria-hidden', 'true')
  }
  for (const el of Array.from(root.querySelectorAll('[data-footnote-marker]'))) {
    el.setAttribute('role', 'note')
  }
}
