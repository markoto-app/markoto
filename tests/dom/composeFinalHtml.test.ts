// @vitest-environment jsdom
//
// jsdom, not happy-dom: the final pass runs DOMPurify (see the note in
// renderMarkdownXss.test.ts).
import { describe, it, expect } from 'vitest'
import { composeFinalHtml } from '../../app/utils/composeFinalHtml'
import { defaultTheme } from '../../shared/utils/defaultTheme'
import { THEME_PRESETS } from '../../shared/utils/themePresets'
import type { DocTheme } from '../../shared/types/theme'

// composeFinalHtml is the last step before HTML reaches the preview
// iframe, the print iframe and the server render page. The theme it
// reads can arrive over Y.js without HTTP validation, so the composed
// document is sanitised as a whole, not just the markdown body.

function parse(html: string): DocumentFragment {
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  return tpl.content
}

function eventHandlerAttrs(html: string): string[] {
  const out: string[] = []
  for (const el of Array.from(parse(html).querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.toLowerCase().startsWith('on')) out.push(`${el.tagName}.${attr.name}`)
    }
  }
  return out
}

function compose(theme: DocTheme, bodyHtml: string): string {
  return composeFinalHtml({ theme, title: 'Title', dateIso: '2026-10-27', bodyHtml })
}

const withLogo = (logoUrl: string): DocTheme => ({
  ...defaultTheme,
  cover: { ...defaultTheme.cover, enabled: true, showLogo: true },
  brand: { ...defaultTheme.brand, logoUrl }
})

describe('composeFinalHtml — sanitised output (regression)', () => {
  it('a logo URL with an attribute breakout yields no event handler', () => {
    const out = compose(withLogo('x" onerror="alert(1)'), '<p>Body</p>')
    expect(eventHandlerAttrs(out)).toEqual([])
    expect(out).not.toContain('onerror')
  })

  it('markup in the body that bypassed renderMarkdown is still sanitised', () => {
    const out = compose(defaultTheme, '<p>Hi</p><img src="x" onerror="alert(1)"><script>alert(2)</script>')
    expect(eventHandlerAttrs(out)).toEqual([])
    expect(parse(out).querySelector('script')).toBeNull()
  })

  it('a dangerous inline style in the body is dropped', () => {
    const out = compose(defaultTheme, '<p style="position:fixed;top:0;left:0;width:100vw;height:100vh">x</p>')
    expect(parse(out).querySelector('p')?.getAttribute('style') ?? '').not.toContain('fixed')
  })
})

describe('composeFinalHtml — features keep working', () => {
  it('own-upload logo renders on the cover, before the body', () => {
    const out = compose(withLogo('/api/files/doc1/AbCdEfGhIjKl.png'), '<p>Body</p>')
    const frag = parse(out)
    const img = frag.querySelector('section.markoto-cover img.markoto-cover-logo')
    expect(img?.getAttribute('src')).toBe('/api/files/doc1/AbCdEfGhIjKl.png')
    // The body paragraph (now the lead, its first word in the opening span) follows the cover.
    expect(frag.firstElementChild?.matches('section.markoto-cover')).toBe(true)
    expect(frag.lastElementChild?.matches('p.markoto-lead')).toBe(true)
    expect(frag.lastElementChild?.textContent).toBe('Body')
  })

  it('drop cap lands on the first body paragraph, not the cover', () => {
    const theme: DocTheme = {
      ...defaultTheme,
      cover: { ...defaultTheme.cover, enabled: true, showSubtitle: true, subtitle: 'Sub' },
      body: { ...defaultTheme.body, dropCap: true }
    }
    // Long enough for a cap (DROPCAP_MIN_CHARS); short openers get none.
    const prose = 'Once upon a time' + ', there was a writer who kept drafting the same opening paragraph'.repeat(4)
    const out = compose(theme, `<p>${prose}</p>`)
    // The cap, then the opening words (documentMarkers.ts) continue the word.
    expect(out).toContain('<span class="markoto-dropcap">O</span><span class="markoto-opening">nce upon a time,</span> there')
    expect(parse(out).querySelector('p.markoto-dropcap-p.markoto-lead > .markoto-dropcap:first-child')).not.toBeNull()
    expect(parse(out).querySelector('.markoto-cover .markoto-dropcap')).toBeNull()
  })

  it('mermaid images (data:image/svg+xml) and their sizing style survive', () => {
    const body = '<div class="mermaid"><img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" style="max-width:100%;display:block;" width="200" height="100"></div>'
    const img = parse(compose(defaultTheme, body)).querySelector('.mermaid img')
    expect(img?.getAttribute('src')).toBe('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')
    expect(img?.getAttribute('style')).toContain('max-width')
    expect(img?.getAttribute('width')).toBe('200')
  })
})

describe('composeFinalHtml — a leading `# <title>` in a title-block layout', () => {
  const titled = '<h1 id="edge-cache">Edge  cache\n behaviour</h1><h2 id="abstract">Abstract</h2><p>We measure.</p><h1 id="intro">Intro</h1>'
  function arxiv(): DocTheme {
    const preset = THEME_PRESETS.find(p => p.id === 'arxiv')
    if (!preset) throw new Error('arxiv preset missing')
    return structuredClone(preset.theme)
  }

  it('composeFinalHtml: title block shows the title once and still takes the abstract', () => {
    const html = composeFinalHtml({ theme: arxiv(), title: 'Edge cache behaviour', date: '6 November 2026', bodyHtml: titled })
    const root = document.createElement('div')
    root.innerHTML = html
    expect(Array.from(root.querySelectorAll('h1')).map(h => h.textContent)).toEqual(['Edge cache behaviour', 'Intro'])
    expect(root.querySelector('.markoto-title-block')?.textContent).toContain('We measure.')
  })

  it('composeFinalHtml: other layouts keep the heading', () => {
    const theme = arxiv()
    theme.cover.layout = 'classic'
    const html = composeFinalHtml({ theme, title: 'Edge cache behaviour', date: '6 November 2026', bodyHtml: titled })
    expect(html).toContain('id="edge-cache"')
  })
})
