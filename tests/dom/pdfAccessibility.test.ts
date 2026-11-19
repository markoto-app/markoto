import { describe, it, expect } from 'vitest'
import { prepareForTaggedPdf } from '../../app/utils/preview/pdfAccessibility'

// The server render page prepares the paginated DOM before Chromium prints
// a tagged PDF: page furniture leaves the accessibility tree, footnotes
// become notes, the text itself is untouched.

describe('prepareForTaggedPdf', () => {
  it('hides margin boxes and marks footnotes as notes', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <div class="pagedjs_page">
        <div class="pagedjs_margin pagedjs_margin-top-center"><div class="pagedjs_margin-content">Report</div></div>
        <div class="pagedjs_area"><h1>Title</h1><p>Body text.</p></div>
        <div class="pagedjs_footnote_area"><span class="footnote" data-footnote-marker="1">A note.</span></div>
        <div class="pagedjs_margin pagedjs_margin-bottom-center"></div>
      </div>`
    prepareForTaggedPdf(root)

    const margins = Array.from(root.querySelectorAll('.pagedjs_margin'))
    expect(margins).toHaveLength(2)
    for (const m of margins) expect(m.getAttribute('aria-hidden')).toBe('true')
    expect(root.querySelector('[data-footnote-marker]')?.getAttribute('role')).toBe('note')
    expect(root.querySelector('h1')?.hasAttribute('aria-hidden')).toBe(false)
    expect(root.querySelector('.pagedjs_area')?.hasAttribute('aria-hidden')).toBe(false)
  })
})
