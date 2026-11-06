// @vitest-environment jsdom
//
// jsdom (not happy-dom): the pipeline runs DOMPurify — see renderMarkdownXss.test.ts.
import { describe, it, expect } from 'vitest'
import { renderMarkdown } from '../../app/utils/renderMarkdown'
import { composeFinalHtml } from '../../app/utils/composeFinalHtml'
import { markUnnumbered } from '../../app/utils/titleBlock'
import { defaultTheme } from '../../shared/utils/defaultTheme'
import type { DocTheme } from '../../shared/types/theme'

// `# References {.unnumbered}` / `{-}` (Pandoc): no section number, the
// counters don't advance, and the TOC entry is marked so the TOC numbers
// skip it too (themeToCss numberingBlock).

function parse(html: string): DocumentFragment {
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  return tpl.content
}

const MD = '[[toc]]\n\n# Introduction\n\n# Method\n\n# References {.unnumbered}\n\n# Appendix {-}\n\n## Details\n'

function numbered(): DocTheme {
  const t = structuredClone(defaultTheme)
  t.cover.enabled = false
  t.headings.numbering = 'decimal'
  return t
}

describe('markdown → unnumbered headings', () => {
  it('{.unnumbered} survives the sanitizer as a class', async () => {
    const root = parse(await renderMarkdown(MD))
    expect(root.querySelector('h1#references')?.className).toBe('unnumbered')
  })

  it('{-} becomes the same class (and no stray "-" attribute)', async () => {
    const html = await renderMarkdown(MD)
    const h = parse(html).querySelector('h1#appendix')
    expect(h?.className).toBe('unnumbered')
    expect(h?.hasAttribute('-')).toBe(false)
    expect(h?.textContent).toBe('Appendix')
  })

  it('{-} combines with other attributes; only headings are affected', async () => {
    const root = parse(await renderMarkdown('# A {- .x #a-id}\n\nText.\n{-}\n'))
    const h = root.querySelector('h1')
    expect(h?.id).toBe('a-id')
    expect(h?.classList.contains('unnumbered')).toBe(true)
    expect(h?.classList.contains('x')).toBe(true)
    expect(root.querySelector('p')?.classList.contains('unnumbered')).toBe(false)
  })
})

describe('markUnnumbered', () => {
  it('marks the TOC entries of unnumbered headings only', () => {
    const body = '<nav class="table-of-contents"><ul><li><a href="#a">A</a></li><li><a href="#refs">Refs</a><ul><li><a href="#sub">Sub</a></li></ul></li></ul></nav>'
      + '<h1 id="a">A</h1><h1 id="refs" class="unnumbered">Refs</h1><h2 id="sub">Sub</h2>'
    const root = parse(markUnnumbered(body))
    const entry = (id: string) => root.querySelector(`a[href="#${id}"]`)?.closest('li')
    expect(entry('refs')?.classList.contains('markoto-unnumbered-entry')).toBe(true)
    expect(entry('a')?.classList.contains('markoto-unnumbered-entry')).toBe(false)
    expect(entry('sub')?.classList.contains('markoto-unnumbered-entry')).toBe(false)
  })

  it('leaves a body without unnumbered headings untouched', () => {
    const body = '<h1 id="a">A</h1><p>unnumbered is just a word here</p>'
    expect(markUnnumbered(body)).toBe(body)
  })
})

describe('composeFinalHtml', () => {
  it('marks the TOC entries when the theme numbers sections', async () => {
    const html = composeFinalHtml({ theme: numbered(), title: 'T', date: '6 November 2026', bodyHtml: await renderMarkdown(MD) })
    const root = parse(html)
    const marked = Array.from(root.querySelectorAll('.table-of-contents li.markoto-unnumbered-entry > a')).map(a => a.getAttribute('href'))
    expect(marked).toEqual(['#references', '#appendix'])
  })

  it('leaves the TOC alone without numbering', async () => {
    const t = numbered()
    t.headings.numbering = 'none'
    const html = composeFinalHtml({ theme: t, title: 'T', date: '6 November 2026', bodyHtml: await renderMarkdown(MD) })
    expect(html).not.toContain('markoto-unnumbered-entry')
    expect(parse(html).querySelector('h1#references')?.classList.contains('unnumbered')).toBe(true)
  })
})
