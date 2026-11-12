// @vitest-environment jsdom
//
// jsdom (not happy-dom): the pipeline runs DOMPurify, see renderMarkdownXss.test.ts.
import { describe, it, expect } from 'vitest'
import { renderMarkdown } from '../../app/utils/markdown/renderMarkdown'
import { composeFinalHtml } from '../../app/utils/preview/composeFinalHtml'
import { markHeadingStructure } from '../../app/utils/preview/headingStructure'
import { markReferences } from '../../app/utils/markdown/references'
import { moveCaptionsBelow } from '../../app/utils/markdown/tableCaptions'
import { defaultTheme } from '../../shared/utils/theme/defaultTheme'
import type { DocTheme } from '../../shared/types/theme'

// Engine-set document structure: Pandoc table captions, number + unit
// cells, section markers ({section}, first section, numbering base), the
// reference-list class, captions below the table.

function parse(html: string): DocumentFragment {
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  return tpl.content
}

function theme(edit: (t: DocTheme) => void = () => {}): DocTheme {
  const t = structuredClone(defaultTheme)
  t.cover.enabled = false
  edit(t)
  return t
}

const TABLE = '| A | B |\n|---|--:|\n| x | 1 |\n| y | 2 |\n'

describe('table captions (Pandoc syntax)', () => {
  it('a "Table:" paragraph after the table becomes its caption', async () => {
    const root = parse(await renderMarkdown(`${TABLE}\nTable: Key *figures*\n`))
    const table = root.querySelector('table')
    expect(table?.firstElementChild?.tagName).toBe('CAPTION')
    expect(table?.querySelector('caption')?.innerHTML).toBe('Key <em>figures</em>')
    expect(root.querySelectorAll('p')).toHaveLength(0)
  })

  it('before the table, the short ":" form and the line right under the table work too', async () => {
    const before = parse(await renderMarkdown(`Table: Above\n\n${TABLE}`))
    expect(before.querySelector('caption')?.textContent).toBe('Above')
    const colon = parse(await renderMarkdown(`${TABLE}\n: Short form\n`))
    expect(colon.querySelector('caption')?.textContent).toBe('Short form')
    const sameLine = parse(await renderMarkdown(`${TABLE}Table: Same line\n`))
    expect(sameLine.querySelector('caption')?.textContent).toBe('Same line')
    expect(sameLine.querySelectorAll('tbody tr')).toHaveLength(2)
  })

  it('attributes land on the caption; {.class} under the table still reaches the table', async () => {
    const root = parse(await renderMarkdown(`${TABLE}{.wide}\n\nTable: Sizes {#tbl-sizes}\n`))
    expect(root.querySelector('table')?.classList.contains('wide')).toBe(true)
    expect(root.querySelector('caption')?.id).toBe('tbl-sizes')
  })

  it('a caption after the first table is not also taken by the second; other paragraphs stay paragraphs', async () => {
    const root = parse(await renderMarkdown(`${TABLE}\nTable: One\n\n${TABLE}\nTable without a colon.\n\nTable:no space\n`))
    const captions = Array.from(root.querySelectorAll('caption')).map(c => c.textContent)
    expect(captions).toEqual(['One'])
    expect(root.querySelectorAll('p')).toHaveLength(2)
  })

  it('caption text is escaped like any paragraph', async () => {
    const html = await renderMarkdown(`${TABLE}\nTable: <img src=x onerror=alert(1)>\n`)
    expect(html).not.toContain('<img')
    expect(parse(html).querySelector('caption')?.textContent).toContain('<img')
  })
})

describe('number + unit in table cells', () => {
  it('wraps pairs inside cells only', async () => {
    const root = parse(await renderMarkdown('Up +8.1 % in text.\n\n| Δ | Class |\n|---|---|\n| +8.1 % | SEV-1 |\n| `5 ms` | 48.6 |\n'))
    const kept = Array.from(root.querySelectorAll('td .markoto-nowrap')).map(s => s.textContent)
    expect(kept).toEqual(['+8.1 %', 'SEV-1'])
    expect(root.querySelector('p .markoto-nowrap')).toBeNull()
    expect(root.querySelector('td code')?.textContent).toBe('5 ms')
  })
})

describe('section markers', () => {
  it('marks the top-level headings and the first one; h1 when present', async () => {
    const root = parse(markHeadingStructure(await renderMarkdown('# One\n\n## Sub\n\n# Two\n'), false))
    const sections = Array.from(root.querySelectorAll('.markoto-section-heading')).map(h => h.id)
    expect(sections).toEqual(['one', 'two'])
    expect(root.querySelectorAll('.markoto-first-section')).toHaveLength(1)
    expect(root.querySelector('.markoto-first-section')?.id).toBe('one')
  })

  it('a document without h1: h2 are the sections and the numbers start there', async () => {
    const html = markHeadingStructure(await renderMarkdown('## Scope\n\n### Data\n\n## Results\n'), true)
    const root = parse(html)
    expect(Array.from(root.querySelectorAll('.markoto-section-heading')).map(h => h.id)).toEqual(['scope', 'results'])
    expect(root.querySelector('h2')?.classList.contains('markoto-num-from-h2')).toBe(true)
    expect(root.querySelector('h3')?.classList.contains('markoto-num-from-h2')).toBe(true)
  })

  it('no numbering base class with h1, without numbering, or for unnumbered headings', async () => {
    expect(markHeadingStructure(await renderMarkdown('# A\n\n## B\n'), true)).not.toContain('markoto-num-from')
    expect(markHeadingStructure(await renderMarkdown('## A\n'), false)).not.toContain('markoto-num-from')
    // An unnumbered h1 (References) doesn't make h1 the numbering base.
    const root = parse(markHeadingStructure(await renderMarkdown('## A\n\n# References {-}\n'), true))
    expect(root.querySelector('h2')?.classList.contains('markoto-num-from-h2')).toBe(true)
    expect(root.querySelector('h1')?.className).not.toContain('markoto-num-from')
  })

  it('the abstract is not a section', async () => {
    const t = theme((p) => {
      p.headings.numbering = 'decimal'
    })
    const html = composeFinalHtml({ theme: t, title: 'T', date: 'd', bodyHtml: await renderMarkdown('# Abstract\n\nText.\n\n# Introduction\n') })
    const first = parse(html).querySelector('.markoto-first-section')
    expect(first?.id).toBe('introduction')
  })
})

describe('reference list', () => {
  it('marks the lists and paragraphs of the References section until the next heading', async () => {
    const md = '# Results\n\n1. not a reference\n\n# References {-}\n\n1. A. Author, "Title."\n2. B. Author, "Title."\n\nKour, G. (2014). Paper.\n\n# Appendix\n\nText.\n'
    const root = parse(markReferences(await renderMarkdown(md)))
    expect(root.querySelector('h1#references')?.classList.contains('markoto-references-heading')).toBe(true)
    const marked = Array.from(root.querySelectorAll('.markoto-references')).map(el => el.tagName)
    expect(marked).toEqual(['OL', 'P'])
    expect(root.querySelector('#appendix + p')?.classList.contains('markoto-references')).toBe(false)
  })

  it('recognises other languages and a trailing colon', async () => {
    for (const heading of ['Literatur', 'Références:', 'Bibliografía', '参考文献', 'Bibliography']) {
      const html = markReferences(await renderMarkdown(`## ${heading}\n\n- Entry\n`))
      expect(parse(html).querySelector('ul')?.classList.contains('markoto-references'), heading).toBe(true)
    }
    expect(markReferences(await renderMarkdown('## Referenced work\n\n- Entry\n'))).not.toContain('markoto-references')
  })
})

describe('captions below the table', () => {
  it('moves the caption after the rows and keeps it there through the final sanitising pass', async () => {
    const body = await renderMarkdown(`${TABLE}\nTable: Below\n`)
    const moved = parse(moveCaptionsBelow(body)).querySelector('table')
    expect(moved?.lastElementChild?.tagName).toBe('CAPTION')
    const t = theme((p) => {
      p.tables.captionPosition = 'below'
    })
    const composed = parse(composeFinalHtml({ theme: t, title: 'T', date: 'd', bodyHtml: body })).querySelector('table')
    expect(composed?.lastElementChild?.tagName).toBe('CAPTION')
    const above = parse(composeFinalHtml({ theme: theme(), title: 'T', date: 'd', bodyHtml: body })).querySelector('table')
    expect(above?.firstElementChild?.tagName).toBe('CAPTION')
  })
})
