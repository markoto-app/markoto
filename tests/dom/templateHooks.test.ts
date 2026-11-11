// @vitest-environment jsdom
//
// jsdom (not happy-dom): the pipeline runs DOMPurify — see renderMarkdownXss.test.ts.
import { describe, it, expect } from 'vitest'
import { renderMarkdown } from '../../app/utils/markdown/renderMarkdown'
import { composeFinalHtml } from '../../app/utils/preview/composeFinalHtml'
import { markHeadingStructure, sectionNumberLabel } from '../../app/utils/preview/headingStructure'
import { numberCaptionsByChapter } from '../../app/utils/markdown/captionNumbers'
import { markDocumentStructure } from '../../app/utils/preview/documentMarkers'
import { defaultTheme } from '../../shared/utils/theme/defaultTheme'
import type { DocTheme } from '../../shared/types/theme'

// Engine hooks: the `{section}` label attribute, chapter-relative caption numbers and the marker classes
// for template CSS (run-in labels, endpoint lines, lead paragraph, opening words, the every-chapter drop cap).

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

async function compose(md: string, edit: (t: DocTheme) => void = () => {}): Promise<DocumentFragment> {
  return parse(composeFinalHtml({ theme: theme(edit), title: 'Doc', date: '', bodyHtml: await renderMarkdown(md) }))
}

const LONG = 'The weighing house at Port Aven had been closed for eleven years when Maëlle Kervran found the ledger. She had come for the scales, a buyer in Quimper wanted the brass beam, and her brother wanted the money, and she found the book instead.'

describe('{section} with its number (data-markoto-section)', () => {
  it('puts number + title on every section heading, the title alone on unnumbered ones', async () => {
    const root = await compose('# Intro\n\ntext\n\n## Sub\n\n# Procedures\n\ntext\n\n# References {.unnumbered}\n\n1. a\n', (t) => {
      t.headings.numbering = 'decimal'
      t.header.sectionNumber = true
    })
    const sections = Array.from(root.querySelectorAll('h1')).map(h => h.getAttribute('data-markoto-section'))
    expect(sections).toEqual(['1 Intro', '2 Procedures', 'References'])
    expect(root.querySelector('h2')?.hasAttribute('data-markoto-section')).toBe(false)
  })

  it('formats the number like the theme CSS; sections at h2 count from 1', () => {
    expect(['decimal', 'decimal-dot', 'ieee', 'decimal-zero'].map(s => sectionNumberLabel(s as 'decimal', 4))).toEqual(['4', '4.', 'IV.', '04'])
    const html = markHeadingStructure('<h2>A</h2><p>x</p><h2>B</h2>', true, 'ieee')
    expect(Array.from(parse(html).querySelectorAll('h2')).map(h => h.getAttribute('data-markoto-section'))).toEqual(['I. A', 'II. B'])
  })

  it('without numbering the attribute is the plain title; without the option there is none', async () => {
    const plain = await compose('# Intro\n\n# Next\n', (t) => {
      t.header.sectionNumber = true
    })
    expect(plain.querySelector('h1')?.getAttribute('data-markoto-section')).toBe('Intro')
    const off = await compose('# Intro\n', (t) => {
      t.headings.numbering = 'decimal'
    })
    expect(off.querySelector('h1')?.hasAttribute('data-markoto-section')).toBe(false)
  })
})

describe('chapter-relative caption numbers', () => {
  const FIG = '![A chart](data:image/png;base64,iVBORw0KGgo=)'
  const TABLE = '| A | B |\n|---|---|\n| x | 1 |\n\nTable: Results\n'

  it('numbers figures and tables within each numbered top-level section', async () => {
    const root = await compose(`${FIG}\n\n# One\n\n${FIG}\n\n${TABLE}\n${FIG}\n\n# Two\n\n${TABLE}\n# Appendix {.unnumbered}\n\n${FIG}\n`, (t) => {
      t.headings.numbering = 'decimal'
      t.blocks.figureLabel = true
      t.tables.captionLabel = true
      t.blocks.captionNumbering = 'chapter'
    })
    const figs = Array.from(root.querySelectorAll('figcaption')).map(f => f.getAttribute('data-markoto-number'))
    expect(figs).toEqual(['1', '1.1', '1.2', '1'])
    const tables = Array.from(root.querySelectorAll('caption')).map(c => c.getAttribute('data-markoto-number'))
    expect(tables).toEqual(['1.1', '2.1'])
  })

  it('skips empty figcaptions (as the CSS counter does) and leaves documents in document mode alone', () => {
    const html = numberCaptionsByChapter('<h1 class="markoto-section-heading">A</h1><figure><img src="x"><figcaption></figcaption></figure><figure><img src="y"><figcaption>B</figcaption></figure>')
    expect(Array.from(parse(html).querySelectorAll('figcaption')).map(f => f.getAttribute('data-markoto-number'))).toEqual([null, '1.1'])
  })

  it('is not applied in document mode', async () => {
    const root = await compose(`# One\n\n${FIG}\n`, (t) => {
      t.blocks.figureLabel = true
    })
    expect(root.querySelector('figcaption')?.hasAttribute('data-markoto-number')).toBe(false)
  })
})

describe('marker classes (renderMarkdown)', () => {
  it('a paragraph opening with a bold run-in label is markoto-labelled', async () => {
    const root = parse(await renderMarkdown('**Example 7.1 (fair die).** Let X be a die.\n\n**Pricing:** CHF 39.\n\n**A whole bold line**\n\n**B** fails the goal.\n\nPlain **bold.** text\n'))
    const ps = Array.from(root.querySelectorAll('p')).map(p => p.classList.contains('markoto-labelled'))
    expect(ps).toEqual([true, true, false, false, false])
  })

  it('an alert whose first paragraph is labelled is markoto-alert-labelled', async () => {
    const root = parse(await renderMarkdown('> [!IMPORTANT]\n> **Theorem 7.3 (linearity).** For any X, Y …\n\n> [!NOTE]\n> Just a note.\n'))
    const alerts = Array.from(root.querySelectorAll('.markdown-alert'))
    expect(alerts.map(a => a.classList.contains('markoto-alert-labelled'))).toEqual([true, false])
    expect(alerts[0]?.querySelector('p.markoto-labelled')).not.toBeNull()
  })

  it('METHOD /path as a paragraph or an http fence is an endpoint line', async () => {
    const root = parse(await renderMarkdown('POST /payments\n\n```http\nGET /payments/{id}\n```\n\n```http\nGET /x HTTP/1.1\nHost: a\n```\n\nPOST is a verb.\n'))
    const p = root.querySelector('p.markoto-endpoint')
    expect(p?.innerHTML).toBe('<span class="markoto-http-method">POST</span> <span class="markoto-http-path">/payments</span>')
    const pres = root.querySelectorAll('pre')
    expect(pres[0]?.classList.contains('markoto-endpoint')).toBe(true)
    expect(pres[0]?.querySelector('code.language-http .markoto-http-method')?.textContent).toBe('GET')
    expect(pres[0]?.querySelector('.markoto-http-path')?.textContent).toBe('/payments/{id}')
    // A full request is ordinary code; a sentence is a paragraph.
    expect(pres[1]?.classList.contains('markoto-endpoint')).toBe(false)
    expect(root.querySelectorAll('.markoto-endpoint')).toHaveLength(2)
  })

  it('escapes the path', async () => {
    const root = parse(await renderMarkdown('```http\nGET /a<b>\n```\n'))
    expect(root.querySelector('script, b')).toBeNull()
    expect(root.querySelector('.markoto-http-path')?.textContent).toBe('/a<b>')
  })
})

describe('lead paragraph + opening words', () => {
  it('the body\'s opening paragraph is the lead; a body opening with a heading has none', async () => {
    const root = await compose('[[toc]]\n\n**Fieldnote turns a voice note into a report.**\n\n## The problem\n\nText.\n')
    expect(root.querySelector('p.markoto-lead')?.textContent).toBe('Fieldnote turns a voice note into a report.')
    const none = await compose('# Intro\n\nText.\n')
    expect(none.querySelector('.markoto-lead')).toBeNull()
  })

  it('wraps the first words after every top-level heading, ending after clause punctuation', async () => {
    const root = await compose('# One\n\n> epigraph\n\nThe weighing house at Port Aven had closed.\n\nSecond paragraph.\n\n## Sub\n\nNo opening here.\n\n# Two\n\n"Maëlle?" she said quietly to him.\n\n# Three\n\n*Italic start* of text.\n')
    const openings = Array.from(root.querySelectorAll('.markoto-opening')).map(s => s.textContent)
    // (typographer: curly quotes)
    expect(openings).toEqual(['The weighing house at', '“Maëlle?”', 'Italic start'])
    expect(root.querySelector('.markoto-opening')?.parentElement?.tagName).toBe('P')
  })

  it('leaves math and footnotes whole', () => {
    const html = markDocumentStructure('<h1 class="markoto-section-heading">A</h1><p><span class="katex">x+y</span> is a sum.</p>', { capChapters: false })
    expect(parse(html).querySelector('.markoto-opening')).toBeNull()
  })
})

describe('body.dropCap', () => {
  it('every-chapter caps the opening paragraph of each top-level section, the opening words continue after the cap', async () => {
    const root = await compose(`Intro paragraph that is long enough. ${LONG}\n\n# One\n\n${LONG}\n\n# Two\n\nShort.\n\n# Three\n\n${LONG}\n`, (t) => {
      t.body.dropCap = 'every-chapter'
    })
    const caps = Array.from(root.querySelectorAll('.markoto-dropcap')).map(s => s.textContent)
    expect(caps).toEqual(['T', 'T'])
    const p = root.querySelector('p.markoto-dropcap-p')
    expect(p?.querySelector('.markoto-dropcap + .markoto-opening')?.textContent).toBe('he weighing house at')
  })

  it('true keeps the single cap on the body\'s first paragraph', async () => {
    const root = await compose(`${LONG}\n\n# One\n\n${LONG}\n`, (t) => {
      t.body.dropCap = true
    })
    expect(root.querySelectorAll('.markoto-dropcap')).toHaveLength(1)
    expect(root.querySelector('p.markoto-lead.markoto-dropcap-p')).not.toBeNull()
  })
})
