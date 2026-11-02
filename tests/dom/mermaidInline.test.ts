// @vitest-environment jsdom
//
// jsdom, not happy-dom: inlineMermaidSvgs sanitises with DOMPurify, which
// happy-dom breaks (see tests/dom/renderMarkdownXss.test.ts).
import { describe, expect, it } from 'vitest'
import { inlineMermaidSvgs, sanitizeMermaidSvg } from '../../app/utils/mermaidLoader'

function b64(s: string): string {
  return btoa(String.fromCodePoint(...new TextEncoder().encode(s)))
}

function page(svg: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = `<div class="mermaid mermaid-pie"><img src="data:image/svg+xml;base64,${b64(svg)}" width="632" height="450" alt=""></div>`
  return root
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" id="mmd-1" viewBox="0 0 632 450" width="632" height="450">'
  + '<style>#mmd-1 text{fill:#1b2430}</style><g class="legend"><text>DACH  3,320</text></g></svg>'

describe('inlineMermaidSvgs (server render page, after pagination)', () => {
  it('swaps the <img> for the SVG with the same intrinsic size', () => {
    const root = page(SVG)
    expect(inlineMermaidSvgs(root)).toBe(1)
    const svg = root.querySelector('.mermaid > svg')
    expect(root.querySelector('.mermaid > img')).toBeNull()
    expect(svg?.getAttribute('width')).toBe('632')
    expect(svg?.getAttribute('height')).toBe('450')
    expect(svg?.namespaceURI).toBe('http://www.w3.org/2000/svg')
    expect(svg?.querySelector('style')?.textContent).toContain('#mmd-1 text')
    expect(svg?.textContent).toContain('DACH  3,320')
  })

  it('strips script, handlers and javascript: links', () => {
    const evil = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)"><script>alert(2)</script>'
      + '<a href="javascript:alert(3)"><text onclick="alert(4)">x</text></a></svg>'
    const root = page(evil)
    inlineMermaidSvgs(root)
    const html = root.innerHTML
    expect(html).not.toMatch(/alert|onload|onclick|<script/i)
  })

  it('keeps diagrams that need <foreignObject> as images', () => {
    const fo = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject></svg>'
    const root = page(fo)
    expect(inlineMermaidSvgs(root)).toBe(0)
    expect(root.querySelector('.mermaid > img')).not.toBeNull()
  })

  it('ignores images that are not mermaid SVG data', () => {
    const root = document.createElement('div')
    root.innerHTML = '<div class="mermaid"><img src="/api/files/doc/x.png"></div><p><img src="data:image/svg+xml;base64,AAAA"></p>'
    expect(inlineMermaidSvgs(root)).toBe(0)
  })

  it('sanitizeMermaidSvg returns null for non-SVG input', () => {
    expect(sanitizeMermaidSvg('<p>hi</p>')).toBeNull()
  })
})
