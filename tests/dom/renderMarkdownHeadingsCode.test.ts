// @vitest-environment jsdom
//
// jsdom (not happy-dom): DOMPurify's checks only behave like Chromium's
// under jsdom — see renderMarkdownXss.test.ts.
import { describe, it, expect } from 'vitest'
import { clobberSafeId, fenceTitle, renderMarkdown, selectorSafeId, wrapCodeLines, wrapCodeTokens } from '../../app/utils/markdown/renderMarkdown'

function parse(html: string): DocumentFragment {
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  return tpl.content
}

describe('heading ids survive sanitising (TOC page numbers)', () => {
  // DOMPurify (SANITIZE_DOM) drops id="method" because `method` is a property of <form>; the TOC link
  // would then point nowhere and paged.js would print page 0 for "Method".
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

describe('heading ids are valid CSS selectors (paged.js)', () => {
  // A heading like "## 3.4.1 — 2026-10-28" must not yield an id that paged.js resolves with an unescaped
  // querySelector('#…') (target-counter()/links); that throws and leaves the whole preview blank.
  it('a heading starting with a digit gets an id that querySelector accepts, and the TOC links to it', async () => {
    const html = await renderMarkdown('[[toc]]\n\n# 2024 results\n\n## 3.4.1 — 2026-10-28\n')
    const root = parse(html)
    const ids = Array.from(root.querySelectorAll('h1, h2')).map(h => h.id)
    expect(ids).toEqual(['h-2024-results', 'h-341-2026-10-28'])
    for (const id of ids) expect(() => root.querySelector(`#${id}`)).not.toThrow()
    const hrefs = Array.from(root.querySelectorAll('.table-of-contents a')).map(a => a.getAttribute('href'))
    expect(hrefs).toEqual(['#h-2024-results', '#h-341-2026-10-28'])
  })

  it('only slugs starting with a digit get the prefix', () => {
    expect(selectorSafeId('2024-results')).toBe('h-2024-results')
    expect(selectorSafeId('results-2024')).toBe('results-2024')
    expect(selectorSafeId('')).toBe('')
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

describe('inline code breaks only between its tokens', () => {
  it('wraps every space-separated token in a span and keeps the spaces as text', async () => {
    const html = await renderMarkdown('Run `curl -s --data-urlencode  \'q=a<b\'` now.')
    const code = parse(html).querySelector('p > code')
    expect(code).not.toBeNull()
    const tokens = Array.from(code?.querySelectorAll('span.markoto-code-token') ?? []).map(s => s.textContent)
    expect(tokens).toEqual(['curl', '-s', '--data-urlencode', '\'q=a<b\''])
    // Copying the code gives the original string (spaces included, escaped text decoded).
    expect(code?.textContent).toBe('curl -s --data-urlencode  \'q=a<b\'')
  })

  it('a single token is one span; fenced code is untouched', async () => {
    const html = await renderMarkdown('`checkout-api`\n\n```sh\na b\n```\n')
    const root = parse(html)
    expect(root.querySelectorAll('p > code > span.markoto-code-token')).toHaveLength(1)
    expect(root.querySelector('pre .markoto-code-token')).toBeNull()
  })

  it('wrapCodeTokens escapes each token', () => {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    expect(wrapCodeTokens('a<b  c&d', esc)).toBe('<span class="markoto-code-token">a&lt;b</span>  <span class="markoto-code-token">c&amp;d</span>')
    expect(wrapCodeTokens(' x ', esc)).toBe(' <span class="markoto-code-token">x</span> ')
  })
})
