// @vitest-environment jsdom
//
// jsdom, not happy-dom: the pipeline runs DOMPurify (see renderMarkdownXss.test.ts).
import { describe, it, expect } from 'vitest'
import { renderMarkdown } from '../../app/utils/markdown/renderMarkdown'
import { composeFinalHtml } from '../../app/utils/preview/composeFinalHtml'
import type { ReferenceProblem } from '../../app/utils/markdown/citationResolve'
import { defaultTheme } from '../../shared/utils/theme/defaultTheme'
import { parseBibliographyText } from '../../shared/utils/citations/bibImport'
import type { CitationStyleId } from '../../shared/utils/citations/citationStyles'
import type { DocTheme } from '../../shared/types/theme'

const BIB = `
@article{smith2020,
  author = {Smith, John and Jones, Kate},
  title = {A Study of Things},
  journal = {Journal of Testing},
  year = 2020, volume = 12, number = 3, pages = {45--67},
  doi = {10.1000/xyz123}
}
@book{knuth1984,
  author = {Donald E. Knuth},
  title = {The {\\TeX}book},
  publisher = {Addison-Wesley},
  year = {1984}
}
`
const items = parseBibliographyText(BIB).items

async function render(md: string, opts: { style?: CitationStyleId, language?: string, theme?: DocTheme } = {}): Promise<{ root: DocumentFragment, problems: ReferenceProblem[], html: string }> {
  let problems: ReferenceProblem[] = []
  const body = await renderMarkdown(md)
  const html = composeFinalHtml({
    theme: opts.theme ?? defaultTheme,
    title: '',
    date: '',
    bodyHtml: body,
    language: opts.language ?? 'en',
    citations: { items, style: opts.style ?? 'apa' },
    onReferenceProblems: (p) => {
      problems = p
    }
  })
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  return { root: tpl.content, problems, html }
}

describe('citations', () => {
  it('formats a parenthetical citation and appends the bibliography', async () => {
    const { root, problems } = await render('As shown [@smith2020, p. 12].\n')
    expect(root.querySelector('p')?.textContent).toBe('As shown (Smith & Jones, 2020, p. 12).')
    expect(root.querySelector('h2.unnumbered, h1.unnumbered, h2, h1')?.textContent).toBe('References')
    const entry = root.querySelector('.csl-entry')
    expect(entry?.id).toBe('ref-smith2020')
    expect(entry?.textContent).toContain('Smith, J., & Jones, K. (2020). A Study of Things.')
    expect(root.querySelector('a.csl-cite-link')?.getAttribute('href')).toBe('#ref-smith2020')
    expect(problems).toEqual([])
  })

  it('lists only cited entries, at [[bibliography]]', async () => {
    const { root } = await render('# Intro\n\nText @knuth1984 says.\n\n[[bibliography]]\n\n# Appendix\n')
    expect(root.querySelector('p')?.textContent).toBe('Text Knuth (1984) says.')
    const entries = root.querySelectorAll('.csl-entry')
    expect(entries).toHaveLength(1)
    // Placed before the appendix heading, not at the end.
    expect(root.querySelector('.markoto-bibliography')?.nextElementSibling?.textContent).toBe('Appendix')
  })

  it('fills an empty References heading', async () => {
    const { root } = await render('Cite [@smith2020].\n\n## References\n')
    const heading = Array.from(root.querySelectorAll('h2')).find(h => h.textContent === 'References')
    expect(heading?.nextElementSibling?.classList.contains('markoto-bibliography')).toBe(true)
    expect(root.querySelectorAll('h2')).toHaveLength(1)
  })

  it('numbers IEEE citations in order of first use', async () => {
    const { root } = await render('First [@knuth1984], then [@smith2020; @knuth1984].\n', { style: 'ieee' })
    expect(root.querySelector('p')?.textContent).toBe('First [1], then [2], [1].')
    expect(Array.from(root.querySelectorAll('.csl-left-margin')).map(e => e.textContent)).toEqual(['[1]', '[2]'])
  })

  it('marks unknown keys in brackets and leaves bare non-keys as text', async () => {
    const { root, problems } = await render('Unknown [@nobody2000]. Mail me @team or joel@example.com.\n')
    expect(root.querySelector('.markoto-broken-ref')?.textContent).toBe('[@nobody2000?]')
    expect(root.querySelector('p')?.textContent).toContain('Mail me @team or joel@example.com.')
    expect(problems).toEqual([{ kind: 'missing-citation', key: 'nobody2000' }])
  })

  it('uses German words for a German document', async () => {
    const { root } = await render('Siehe [@smith2020, S. 3].\n', { language: 'de' })
    expect(root.querySelector('p')?.textContent).toBe('Siehe (Smith & Jones, 2020, S. 3).')
    expect(Array.from(root.querySelectorAll('h1, h2')).at(-1)?.textContent).toBe('Literatur')
  })

  it('leaves code alone', async () => {
    const { root } = await render('`[@smith2020]` and\n\n```\n@smith2020\n```\n')
    expect(root.querySelector('.csl-entry')).toBeNull()
    expect(root.querySelector('code')?.textContent).toBe('[@smith2020]')
  })

  it('does not take links or footnotes for citations', async () => {
    const { root } = await render('[see @x](https://example.com) and a note[^1].\n\n[^1]: Footnote.\n')
    expect(root.querySelector('a[href="https://example.com"]')).not.toBeNull()
    expect(root.querySelector('.markoto-broken-ref')).toBeNull()
  })
})

describe('cross-references', () => {
  it('numbers figures, tables and equations and links references', async () => {
    const md = [
      'See @fig:cat, [@tbl:data] and @eq:energy.',
      '',
      '![A cat](https://example.com/cat.png){#fig:cat}',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      'Table: Some data {#tbl:data}',
      '',
      '$$',
      'E = mc^2',
      '$$ {#eq:energy}',
      ''
    ].join('\n')
    const { root, problems } = await render(md)
    expect(problems).toEqual([])
    const links = Array.from(root.querySelectorAll('a.markoto-xref'))
    expect(links.map(a => a.textContent)).toEqual(['Figure 1', 'Table 1', 'Equation (1)'])
    expect(links.map(a => a.getAttribute('href'))).toEqual(['#xref-fig-cat', '#xref-tbl-data', '#xref-eq-energy'])
    expect(root.querySelector('figure#xref-fig-cat figcaption')?.textContent).toBe('Figure 1: A cat')
    expect(root.querySelector('table#xref-tbl-data caption')?.textContent).toBe('Table 1: Some data')
    expect(root.querySelector('div.markoto-equation#xref-eq-energy')?.getAttribute('data-markoto-number')).toBe('(1)')
    expect(root.querySelector('div.markoto-equation .katex')).not.toBeNull()
    expect(root.querySelector('[id*=":"]')).toBeNull()
  })

  it('uses the document language and plural forms', async () => {
    const md = 'Siehe [@fig:a; @fig:b].\n\n![Eins](https://e.x/a.png){#fig:a}\n\n![Zwei](https://e.x/b.png){#fig:b}\n'
    const { root } = await render(md, { language: 'de' })
    expect(root.querySelector('a.markoto-xref')?.textContent).toBe('Abbildungen 1 und 2')
  })

  it('refers to numbered sections and keeps TOC links working', async () => {
    const theme: DocTheme = { ...defaultTheme, headings: { ...defaultTheme.headings, numbering: 'decimal' } }
    const md = '[[toc]]\n\n# Intro\n\n# Methods {#sec:methods}\n\n## Setup {#sec:setup}\n\nAs in @sec:setup.\n'
    const { root } = await render(md, { theme })
    expect(root.querySelector('a.markoto-xref')?.textContent).toBe('Section 2.1')
    for (const a of Array.from(root.querySelectorAll('.table-of-contents a'))) {
      const href = (a.getAttribute('href') ?? '').slice(1)
      expect(root.getElementById?.(href) ?? root.querySelector(`[id="${href}"]`), href).not.toBeNull()
    }
  })

  it('marks unknown and duplicate labels', async () => {
    const md = 'See @fig:missing.\n\n![A](https://e.x/a.png){#fig:a}\n\n![B](https://e.x/b.png){#fig:a}\n'
    const { root, problems } = await render(md)
    expect(root.querySelector('.markoto-broken-ref')?.textContent).toBe('@fig:missing?')
    expect(problems).toContainEqual({ kind: 'missing-label', key: 'fig:missing' })
    expect(problems).toContainEqual({ kind: 'duplicate-label', key: 'fig:a' })
  })

  it('builds a list of figures', async () => {
    const md = '[[lof]]\n\n![First](https://e.x/a.png)\n\n![Second](https://e.x/b.png){#fig:b}\n'
    const { root } = await render(md)
    const entries = Array.from(root.querySelectorAll('.markoto-lof li'))
    expect(entries.map(li => li.textContent)).toEqual(['Figure 1First', 'Figure 2Second'])
    const href = entries[1]?.querySelector('a')?.getAttribute('href') ?? ''
    expect(root.querySelector(`figure[id="${href.slice(1)}"]`)).not.toBeNull()
  })
})
