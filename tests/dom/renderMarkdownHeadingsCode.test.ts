// @vitest-environment jsdom
//
// jsdom (not happy-dom): DOMPurify's checks only behave like Chromium's
// under jsdom — see renderMarkdownXss.test.ts.
import { describe, it, expect } from 'vitest'
import { clobberSafeId, fenceTitle, renderMarkdown, wrapCodeLines } from '../../app/utils/renderMarkdown'

function parse(html: string): DocumentFragment {
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  return tpl.content
}

describe('heading ids survive sanitising (TOC page numbers)', () => {
  // Regression: DOMPurify (SANITIZE_DOM) drops id="method" because
  // `method` is a property of <form>; the TOC link then pointed nowhere and
  // paged.js printed page 0 for "Method".
  it('a heading named like a DOM property keeps an id the TOC links to', async () => {
    const html = await renderMarkdown('[[toc]]\n\n# Introduction\n\n# Method\n\n# Title\n\n# Action\n')
    const root = parse(html)
    for (const a of Array.from(root.querySelectorAll('.table-of-contents a'))) {
      const href = a.getAttribute('href') ?? ''
      expect(href.startsWith('#'), href).toBe(true)
      expect(root.querySelector(`[id="${href.slice(1)}"]`), `${a.textContent} → ${href}`).not.toBeNull()
    }
    expect(root.querySelector('h1#introduction')).not.toBeNull()
    expect(root.querySelector('h1#method-section')?.textContent).toBe('Method')
  })

  it('only clobbering slugs get the suffix', () => {
    expect(clobberSafeId('method')).toBe('method-section')
    expect(clobberSafeId('title')).toBe('title-section')
    expect(clobberSafeId('introduction')).toBe('introduction')
    expect(clobberSafeId('')).toBe('')
  })
})

describe('code blocks', () => {
  it('wraps every line in a numbered span (one block per line, no bare newlines)', async () => {
    const src = 'const a = `x\ny`\n\nconst b = 2\n'
    const html = await renderMarkdown('```ts\n' + src + '```\n')
    const code = parse(html).querySelector('pre code')
    const lines = Array.from(code?.querySelectorAll(':scope > .code-line') ?? [])
    expect(lines.map(l => l.getAttribute('data-line'))).toEqual(['1', '2', '3', '4'])
    expect(lines.map(l => l.textContent)).toEqual(['const a = `x', 'y`', '', 'const b = 2'])
    // No whitespace-only text nodes between the lines: paged.js drops them
    // when it continues a split block on the next page.
    expect(Array.from(code?.childNodes ?? []).every(n => n.nodeType === 1)).toBe(true)
  })

  it('re-opens highlight spans that cross a line break', () => {
    const out = wrapCodeLines('<span class="hljs-string">`a\nb`</span>\nc\n')
    expect(out).toBe(
      '<span class="code-line" data-line="1"><span class="hljs-string">`a</span></span>'
      + '<span class="code-line" data-line="2"><span class="hljs-string">b`</span></span>'
      + '<span class="code-line" data-line="3">c</span>'
    )
  })

  it('leaves mermaid source unwrapped (it becomes a diagram)', async () => {
    const html = await renderMarkdown('```mermaid\nflowchart LR\n  A --> B\n```\n')
    expect(parse(html).querySelector('code.language-mermaid .code-line')).toBeNull()
  })

  it('shows a fence title as an escaped caption above the block', async () => {
    const html = await renderMarkdown('```ts title="replay.ts"\nlet x = 1\n```\n')
    const block = parse(html).querySelector('.code-block')
    expect(block?.querySelector(':scope > .code-title')?.textContent).toBe('replay.ts')
    expect(block?.querySelector(':scope > pre > code.language-ts')).not.toBeNull()
  })

  it('a hostile fence title stays text', async () => {
    const html = await renderMarkdown('```js title="<img src=x onerror=alert(1)>"\n1\n```\n')
    const root = parse(html)
    expect(root.querySelector('img')).toBeNull()
    expect(root.querySelector('[onerror]')).toBeNull()
    expect(root.querySelector('.code-title')?.textContent).toBe('<img src=x onerror=alert(1)>')
  })

  it('parses title="…", title=\'…\' and title=word', () => {
    expect(fenceTitle('title="a b.ts"')).toBe('a b.ts')
    expect(fenceTitle('x title=\'c.py\' y')).toBe('c.py')
    expect(fenceTitle('title=main.go')).toBe('main.go')
    expect(fenceTitle('subtitle=no')).toBe('')
  })
})
