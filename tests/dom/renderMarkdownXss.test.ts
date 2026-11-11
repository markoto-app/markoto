// @vitest-environment jsdom
//
// jsdom, not the dom project's default happy-dom: DOMPurify >= 3.4.8 walks
// the tree with anti-clobbering `Node.prototype` getters that happy-dom
// 20/21 implements incorrectly (capricorn86/happy-dom#2182, #2310). Under
// happy-dom the sanitizer silently skips nodes — allowlisted tags vanish
// and disallowed `href` schemes survive — so this suite would be testing
// happy-dom, not our sanitizer. jsdom is DOMPurify's supported non-browser
// DOM, and its output matches real Chromium for this config.
import { describe, it, expect } from 'vitest'
import { renderMarkdown } from '../../app/utils/markdown/renderMarkdown'

// XSS sanitization boundary for the markdown render pipeline.
//
// The attack model is: user posts markdown → we render it → another
// user's browser loads the result. A hole anywhere in markdown-it's
// parsing or DOMPurify's allowlist = script-in-victim's-session.
//
// Verification strategy: parse the rendered HTML into a real DOM (via
// happy-dom) and walk it for dangerous tags/attrs/schemes. This matches
// what the browser will actually execute — regex-matching the HTML
// string catches false positives (e.g. `<img ...>` that's been escaped
// to literal text by markdown-it's `html:false` is harmless, but a
// naive regex flags it).

const DANGEROUS_TAGS = new Set([
  'script', 'iframe', 'object', 'embed', 'form',
  'style', 'svg', 'link', 'meta', 'base'
])

const DANGEROUS_HREF_SCHEMES = [
  'javascript:', 'vbscript:', 'data:text/html', 'file:'
]

interface DangerFinding {
  kind: 'tag' | 'attr' | 'href'
  detail: string
}

function parseDoc(html: string): HTMLElement {
  const div = document.createElement('div')
  div.innerHTML = html
  return div
}

/**
 * Walk the DOM and collect anything dangerous. Returns a list of
 * human-readable findings — empty array means "sanitizer did its job".
 */
function findDangers(html: string): DangerFinding[] {
  const out: DangerFinding[] = []
  const root = parseDoc(html)
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
  let n: Node | null
  while ((n = walker.nextNode())) {
    const el = n as Element
    const tag = el.tagName.toLowerCase()
    if (DANGEROUS_TAGS.has(tag)) {
      out.push({ kind: 'tag', detail: tag })
      continue
    }
    for (const attr of el.attributes) {
      if (attr.name.toLowerCase().startsWith('on')) {
        out.push({ kind: 'attr', detail: `${attr.name} on <${tag}>` })
      }
    }
    if (tag === 'a' && el.hasAttribute('href')) {
      const href = el.getAttribute('href')!.trim().toLowerCase()
      if (DANGEROUS_HREF_SCHEMES.some(s => href.startsWith(s))) {
        out.push({ kind: 'href', detail: href })
      }
    }
    if (tag === 'img' && el.hasAttribute('src')) {
      const src = el.getAttribute('src')!.trim().toLowerCase()
      if (src.startsWith('javascript:') || src.startsWith('vbscript:')) {
        out.push({ kind: 'href', detail: `img src=${src}` })
      }
    }
  }
  return out
}

describe('renderMarkdown — XSS vectors produce safe DOM', () => {
  it('<script> tags never survive into the DOM', async () => {
    const html = await renderMarkdown('Hi <script>alert(1)</script>')
    expect(findDangers(html)).toEqual([])
  })

  it('<iframe> never survives', async () => {
    const html = await renderMarkdown('<iframe src="evil.com"></iframe>')
    expect(findDangers(html)).toEqual([])
  })

  it('<img src=x onerror=...> produces no onerror attribute in the DOM', async () => {
    // markdown-it with `html: false` escapes raw HTML to text, so this
    // is actually a weak attack. But if markdown-it ever flips to
    // html:true by mistake, DOMPurify is the backstop. Test the DOM
    // regardless.
    const html = await renderMarkdown('<img src=x onerror="alert(1)">')
    expect(findDangers(html)).toEqual([])
  })

  it('[link](javascript:...) markdown does not produce a live javascript: href', async () => {
    const html = await renderMarkdown('[click](javascript:alert(1))')
    expect(findDangers(html)).toEqual([])
  })

  it('[link](data:text/html,...) does not produce a data:text/html href', async () => {
    const html = await renderMarkdown('[x](data:text/html,<script>alert(1)</script>)')
    expect(findDangers(html)).toEqual([])
  })

  it('[link](vbscript:...) is neutered', async () => {
    const html = await renderMarkdown('[x](vbscript:msgbox(1))')
    expect(findDangers(html)).toEqual([])
  })

  it('[link](file:///etc/passwd) is neutered', async () => {
    const html = await renderMarkdown('[x](file:///etc/passwd)')
    expect(findDangers(html)).toEqual([])
  })

  it('<style> blocks never enter the DOM', async () => {
    const html = await renderMarkdown('<style>body{background:red}</style>')
    expect(findDangers(html)).toEqual([])
  })

  it('<object>, <embed>, <form> never enter the DOM', async () => {
    const html = await renderMarkdown(
      '<object data="evil.swf"></object>\n\n<embed src="evil.swf">\n\n<form action="evil"><input></form>'
    )
    expect(findDangers(html)).toEqual([])
  })

  it('<svg> is stripped entirely (not in allowlist)', async () => {
    const html = await renderMarkdown('<svg><circle r="5"/><script>alert(1)</script></svg>')
    expect(findDangers(html)).toEqual([])
    // Extra: the svg tag itself is gone (findDangers covers this, but
    // pin the tag-level absence too).
    expect(parseDoc(html).querySelector('svg')).toBeNull()
  })

  it('<meta>, <link>, <base> tags never enter the DOM', async () => {
    const html = await renderMarkdown(
      '<meta http-equiv="refresh" content="0;url=evil.com">\n\n'
      + '<link rel="stylesheet" href="evil.css">\n\n'
      + '<base href="http://evil.com/">'
    )
    expect(findDangers(html)).toEqual([])
  })

  it('onclick on an allowed tag is stripped', async () => {
    // Raw `<a onclick=...>` gets HTML-escaped to text by markdown-it's
    // html:false, so it arrives at DOMPurify as text content — safe.
    // DOMPurify is the backstop if that ever changes.
    const html = await renderMarkdown('<a href="#" onclick="alert(1)">x</a>')
    expect(findDangers(html)).toEqual([])
  })

  it('encoded event handlers in raw HTML are neutered', async () => {
    const html = await renderMarkdown('<img src=x on&#101;rror=alert(1)>')
    expect(findDangers(html)).toEqual([])
  })

  it('unknown custom elements are stripped', async () => {
    const html = await renderMarkdown('<custom-xss>hi</custom-xss>')
    expect(parseDoc(html).querySelector('custom-xss')).toBeNull()
  })

  it('image syntax with javascript: URL does not leak the scheme into src', async () => {
    // A markdown image `![alt](javascript:...)` — similar to the link
    // case. markdown-it's validateLink should neuter this at parse
    // time; DOMPurify is the second layer.
    const html = await renderMarkdown('![x](javascript:alert(1))')
    expect(findDangers(html)).toEqual([])
  })
})

describe('renderMarkdown — URL scheme allowlist on links', () => {
  function hrefOf(html: string): string | null {
    const a = parseDoc(html).querySelector('a')
    return a?.getAttribute('href') ?? null
  }

  it('allows https:', async () => {
    expect(hrefOf(await renderMarkdown('[s](https://example.com)'))).toBe('https://example.com')
  })

  it('allows http:', async () => {
    expect(hrefOf(await renderMarkdown('[s](http://example.com)'))).toBe('http://example.com')
  })

  it('allows mailto:', async () => {
    expect(hrefOf(await renderMarkdown('[m](mailto:x@y.com)'))).toBe('mailto:x@y.com')
  })

  it('allows relative paths', async () => {
    expect(hrefOf(await renderMarkdown('[d](/api/files/abc/1.png)')))
      .toBe('/api/files/abc/1.png')
  })

  it('allows fragment-only links', async () => {
    expect(hrefOf(await renderMarkdown('[j](#section)'))).toBe('#section')
  })

  it('allows protocol-relative URLs', async () => {
    expect(hrefOf(await renderMarkdown('[x](//cdn.example.com/x)')))
      .toBe('//cdn.example.com/x')
  })

  it('strips tel: href (not in allowlist) while leaving the <a> wrapper', async () => {
    // tel: fails our ALLOWED_URI_REGEXP, so DOMPurify drops the href
    // attribute. The anchor element itself stays (as a wrapper around
    // the link text), but it's inert — clicking does nothing.
    const root = parseDoc(await renderMarkdown('[call](tel:+1234567890)'))
    const a = root.querySelector('a')
    expect(a).not.toBeNull()
    expect(a?.getAttribute('href')).toBeNull()
  })
})

describe('renderMarkdown — legit features pass through', () => {
  it('renders heading with stable id', async () => {
    const root = parseDoc(await renderMarkdown('## My Section\n'))
    const h2 = root.querySelector('h2')
    expect(h2).not.toBeNull()
    expect(h2?.getAttribute('id')).toBe('my-section')
  })

  it('renders code blocks with hljs + language class', async () => {
    const root = parseDoc(await renderMarkdown('```js\nconst x = 1\n```\n'))
    const code = root.querySelector('pre > code')
    expect(code?.classList.contains('hljs')).toBe(true)
    expect(code?.classList.contains('language-js')).toBe(true)
  })

  it('renders tables with thead and tbody', async () => {
    const root = parseDoc(await renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n'))
    expect(root.querySelector('table')).not.toBeNull()
    expect(root.querySelector('thead')).not.toBeNull()
    expect(root.querySelector('tbody')).not.toBeNull()
  })

  it('renders task list with checkbox input', async () => {
    const root = parseDoc(await renderMarkdown('- [x] done\n- [ ] todo\n'))
    const boxes = root.querySelectorAll('input[type="checkbox"]')
    expect(boxes.length).toBe(2)
    expect((boxes[0] as HTMLInputElement).checked).toBe(true)
    expect((boxes[1] as HTMLInputElement).checked).toBe(false)
  })

  it('renders emoji as raw unicode (no HTML)', async () => {
    const html = await renderMarkdown('I :heart: you\n')
    expect(html).toContain('❤')
  })

  it('renders GitHub alerts', async () => {
    const root = parseDoc(await renderMarkdown('> [!NOTE]\n> heads up\n'))
    const alert = root.querySelector('.markdown-alert')
    expect(alert).not.toBeNull()
  })

  it('renders KaTeX with the katex class (visual layout preserved)', async () => {
    // Note: MathML output ALSO ships but only when the host document
    // has a proper doctype. happy-dom defaults to quirks mode and KaTeX
    // suppresses MathML there. In prod Nuxt renders with a doctype so
    // the MathML path is alive; we don't assert it here.
    const root = parseDoc(await renderMarkdown('$x^2$\n'))
    const katex = root.querySelector('.katex')
    expect(katex).not.toBeNull()
  })

  it('preserves inline style on KaTeX output (allowlisted for layout positioning)', async () => {
    // KaTeX uses inline `style` for fraction bars, square-root heights,
    // etc. DOMPurify v3 sanitizes style values (strips expression(),
    // url(javascript:…)) but allows the attribute.
    const root = parseDoc(await renderMarkdown('$\\frac{a}{b}$\n'))
    const styled = root.querySelectorAll('[style]')
    expect(styled.length).toBeGreaterThan(0)
  })

  it('keeps every KaTeX inline style declaration', async () => {
    const formulas = String.raw`\frac{a}{b} + \sqrt[3]{x^2} + \overline{AB} + \color{#b5371f}{c} + \underbrace{x+y}_{n} + \boxed{z} + \cancel{q}`
    const { default: katex } = await import('katex')
    const expected = Array.from(
      parseDoc(katex.renderToString(formulas, { output: 'html' })).querySelectorAll('[style]'),
      el => el.getAttribute('style')?.replaceAll(/\s+/g, '').replace(/;$/, '')
    )
    const root = parseDoc(await renderMarkdown(`$${formulas}$\n`))
    const actual = Array.from(root.querySelectorAll('.katex-html [style]'), el => el.getAttribute('style')?.replaceAll(/\s+/g, '').replace(/;$/, ''))
    expect(expected.length).toBeGreaterThan(10)
    expect(actual).toEqual(expected)
  })

  it('keeps KaTeX\'s stretchy SVG (underbrace, sqrt, cancel) with its geometry only', async () => {
    const formulas = String.raw`\underbrace{x+y}_{n} + \sqrt{2} + \cancel{q} + \widehat{abc}`
    const { default: katex } = await import('katex')
    const raw = parseDoc(katex.renderToString(formulas, { output: 'html' }))
    const root = parseDoc(await renderMarkdown(`$${formulas}$\n`))
    const html = root.querySelector('.katex-html')
    expect(html).not.toBeNull()
    // Same SVG shapes as KaTeX's own output, same path data.
    const shape = (el: Element) => `${el.localName}:${el.getAttribute('d') ?? ''}${el.getAttribute('x2') ?? ''}`
    const expected = Array.from(raw.querySelectorAll('svg path, svg line'), shape)
    expect(expected.length).toBeGreaterThan(3)
    expect(Array.from(html?.querySelectorAll('svg path, svg line') ?? [], shape)).toEqual(expected)
    for (const svg of Array.from(root.querySelectorAll('svg'))) {
      expect(svg.closest('.katex-html'), 'svg outside KaTeX').not.toBeNull()
      expect(svg.getAttribute('viewBox') ?? svg.getAttribute('width')).toBeTruthy()
      for (const attr of Array.from(svg.attributes)) expect(['width', 'height', 'viewbox', 'preserveaspectratio', 'style']).toContain(attr.name.toLowerCase())
    }
  })

  it('drops SVG anywhere but inside KaTeX output, and SVG attributes on HTML elements', async () => {
    const { sanitizeRenderedHtml } = await import('../../app/utils/markdown/sanitizeHtml')
    const out = parseDoc(sanitizeRenderedHtml([
      '<p><svg width="10"><path d="M0 0"/></svg></p>',
      '<span class="katex"><span class="katex-html"><svg width="1em" onload="alert(1)"><path d="M0 0" fill="url(#x)" onclick="x()"/><a href="javascript:alert(1)"><text>x</text></a><use href="#p"/><script>alert(1)</script><svg><path d="M1 1"/></svg></svg></span></span>',
      '<span d="M0 0" viewbox="0 0 1 1" x1="3">t</span>'
    ].join('')))
    const svgs = Array.from(out.querySelectorAll('svg'))
    expect(svgs).toHaveLength(1)
    expect(svgs[0]?.closest('.katex-html')).not.toBeNull()
    expect(svgs[0]?.hasAttribute('onload')).toBe(false)
    expect(Array.from(out.querySelectorAll('path'), p => Array.from(p.attributes, a => a.name))).toEqual([['d']])
    expect(out.querySelector('a, use, script, text')).toBeNull()
    const span = out.querySelector('span[d], span[viewbox], span[x1]')
    expect(span).toBeNull()
  })

  it('renders footnotes transformed to inline span (paged-media shape)', async () => {
    // The render pipeline post-processes `<sup class="footnote-ref">`
    // into an inline `<span class="footnote">` so paged.js's
    // `float: footnote` CSS can reposition them at print time. See
    // transformFootnotesForPagedMedia. Tests the transformed output,
    // which is what gets displayed.
    const root = parseDoc(await renderMarkdown('here[^1]\n\n[^1]: note\n'))
    const fn = root.querySelector('span.footnote')
    expect(fn).not.toBeNull()
    expect(fn?.textContent?.trim()).toBe('note')
  })

  it('renders custom pagebreak rule as <div class="page-break">', async () => {
    const root = parseDoc(await renderMarkdown('a\n\n<!-- pagebreak -->\n\nb\n'))
    const pb = root.querySelector('div.page-break')
    expect(pb).not.toBeNull()
  })

  it('renders <mark> highlights', async () => {
    const root = parseDoc(await renderMarkdown('This is ==important==.\n'))
    expect(root.querySelector('mark')).not.toBeNull()
  })

  it('renders <ins> underlines', async () => {
    const root = parseDoc(await renderMarkdown('This is ++inserted++.\n'))
    expect(root.querySelector('ins')).not.toBeNull()
  })

  it('renders <sub> and <sup>', async () => {
    const root = parseDoc(await renderMarkdown('H~2~O and X^2^\n'))
    expect(root.querySelector('sub')).not.toBeNull()
    expect(root.querySelector('sup')).not.toBeNull()
  })

  it('renders definition lists', async () => {
    const root = parseDoc(await renderMarkdown('term\n:   definition\n'))
    expect(root.querySelector('dl')).not.toBeNull()
    expect(root.querySelector('dt')).not.toBeNull()
    expect(root.querySelector('dd')).not.toBeNull()
  })

  it('renders abbreviations with title attribute', async () => {
    const root = parseDoc(await renderMarkdown('HTML is great\n\n*[HTML]: HyperText Markup Language\n'))
    const abbr = root.querySelector('abbr')
    expect(abbr).not.toBeNull()
    expect(abbr?.getAttribute('title')).toBe('HyperText Markup Language')
  })

  it('renders images with src and alt', async () => {
    const root = parseDoc(await renderMarkdown('![cap](https://example.com/x.png)\n'))
    const img = root.querySelector('img')
    expect(img?.getAttribute('src')).toBe('https://example.com/x.png')
    expect(img?.getAttribute('alt')).toBe('cap')
  })
})

describe('renderMarkdown — link target hardening', () => {
  it('adds target="_blank" and rel="noopener noreferrer" to external links', async () => {
    // Prevents window.opener tabnabbing on user-clicked links, and
    // isolates referrer info from third parties.
    const root = parseDoc(await renderMarkdown('[site](https://example.com)\n'))
    const a = root.querySelector('a')
    expect(a?.getAttribute('target')).toBe('_blank')
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer')
  })
})

describe('renderMarkdown — allowlist semantics', () => {
  it('preserves class attributes (used by hljs, alerts, katex, footnotes)', async () => {
    const root = parseDoc(await renderMarkdown('> [!NOTE]\n> x\n'))
    const alert = root.querySelector('.markdown-alert')
    expect(alert?.className).toContain('markdown-alert')
  })

  it('preserves id attributes (needed for heading anchors and footnote links)', async () => {
    const root = parseDoc(await renderMarkdown('## Hello world\n'))
    expect(root.querySelector('h2')?.id).toBe('hello-world')
  })

  it('strips arbitrary non-allowlisted attributes injected via attrs plugin', async () => {
    // The attrs plugin lets authors add attributes to HTML tokens via
    // `{attr=val}` syntax. Anything not in ALLOWED_ATTR must disappear.
    const html = await renderMarkdown('## Heading {foo="bar"}\n')
    const h2 = parseDoc(html).querySelector('h2')
    expect(h2).not.toBeNull()
    expect(h2?.getAttribute('foo')).toBeNull()
  })

  it('documented {style=…} layout attributes still work', async () => {
    const img = parseDoc(await renderMarkdown('![A caption](photo.jpg){style="width: 50%; float: right"}\n')).querySelector('img')
    expect(img?.getAttribute('style')?.replaceAll(/\s+/g, '')).toBe('width:50%;float:right')
    const p = parseDoc(await renderMarkdown('Centered {style="text-align: center"}\n')).querySelector('p')
    expect(p?.getAttribute('style')?.replaceAll(/\s+/g, '')).toBe('text-align:center')
  })

  // Regression: DOMPurify does not parse CSS, so `style` values used to
  // pass through verbatim (overlays, external url() beacons).
  it.each([
    ['position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9;background-color:red', ['fixed', 'z-index', '100vw'], 'top: 0; left: 0; background-color: red'],
    ['color:red;background-image:url(x.png)', ['url(', 'background-image'], 'color: red'],
    ['font-weight:600;background:url(x.png)', ['url('], 'font-weight: 600'],
    [String.raw`width:10px;behavior:url(x.htc);-moz-binding:url(x)`, ['behavior', 'binding'], 'width: 10px'],
    [String.raw`color:\72 ed;width:expression(alert(1))`, ['expression', String.raw`\72`], null],
    ['width:var(--x);height:env(safe-area-inset-top)', ['var(', 'env('], null],
    ['content:"x";cursor:url(x.cur),auto', ['content', 'cursor'], null]
  ])('unsafe {style=%s} is filtered', async (style, gone, kept) => {
    const html = await renderMarkdown(`**b**{style="${style}"} tail\n`)
    const value = parseDoc(html).querySelector('strong')?.getAttribute('style') ?? null
    for (const g of gone) expect(value ?? '').not.toContain(g)
    expect(value).toBe(kept)
  })

  it('safe declarations survive next to a filtered one', async () => {
    const html = await renderMarkdown('**b**{style="position:fixed;color:#b5371f;font-weight:600"}\n')
    expect(parseDoc(html).querySelector('strong')?.getAttribute('style')?.replaceAll(/\s+/g, '')).toBe('color:#b5371f;font-weight:600')
  })

  it('data-* attributes pass through (DOMPurify default — documented quirk)', async () => {
    // DOMPurify's default `ALLOW_DATA_ATTR` is true, so data-* survives
    // even without appearing in ALLOWED_ATTR. data-* can't execute
    // code, so this isn't an XSS vector; flip to `ALLOW_DATA_ATTR:
    // false` in SANITIZE_OPTS if we ever want stricter policy. Pinned
    // here so a flip is an explicit decision, not an accident.
    const html = await renderMarkdown('## Heading {data-custom="leak"}\n')
    expect(parseDoc(html).querySelector('h2')?.getAttribute('data-custom')).toBe('leak')
  })
})
