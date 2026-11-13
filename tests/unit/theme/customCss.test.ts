import { describe, it, expect } from 'vitest'
import {
  sanitizeCustomCss,
  adaptCustomCssToDoc,
  rewriteCustomCssDocId,
  formatCustomCssIssues,
  type SanitizeCustomCssOptions
} from '../../../shared/utils/theme/customCss'
import { CUSTOM_CSS_MAX_BYTES } from '../../../shared/types/customCss'
import { DocThemeSchema } from '../../../shared/types/theme'
import { defaultTheme } from '../../../shared/utils/theme/defaultTheme'
import { themeToCss } from '../../../shared/utils/theme/themeToCss'

// The custom-CSS sanitizer is the only thing standing between a doc
// editor (or anyone writing `ymeta.theme` over Y.js) and the preview
// iframe / print page / server renderer. Every forbidden construct gets
// a case here, including the obfuscations a regex-based filter misses.

const DOC = 'doc1'
const OPTS: SanitizeCustomCssOptions = { docId: DOC, allowedOrigins: ['https://app.test'] }

function run(css: string, opts: SanitizeCustomCssOptions = OPTS) {
  return sanitizeCustomCss(css, opts)
}

/** No issues AND the output still contains every expected fragment. */
function expectKept(css: string, ...fragments: string[]) {
  const r = run(css)
  expect(r.issues, JSON.stringify(r.issues)).toEqual([])
  for (const f of fragments) expect(r.css).toContain(f)
  return r
}

/** At least one issue with `code`, and none of `gone` survives in the output. */
function expectRejected(css: string, code: string, ...gone: RegExp[]) {
  const r = run(css)
  expect(r.issues.map(i => i.code), `${css} → ${JSON.stringify(r.issues)}`).toContain(code)
  for (const g of gone) expect(r.css).not.toMatch(g)
  return r
}

describe('allowed constructs survive', () => {
  it('empty / whitespace input is a no-op', () => {
    expect(run('')).toEqual({ css: '', issues: [], urls: [] })
    expect(run('  \n\t ')).toEqual({ css: '', issues: [], urls: [] })
  })

  it('plain style rules, selectors, !important', () => {
    expectKept(
      '.paged-doc h1 { color: #b5371f !important; letter-spacing: -0.01em } p:has(> img) + p::first-line { font-variant: small-caps }',
      'color:#b5371f!important', 'p:has(>img)+p::first-line'
    )
  })

  it('@page with margin boxes (paged.js) incl. named + pseudo pages', () => {
    expectKept(
      '@page { @bottom-center { content: counter(page) " / " counter(pages) } @top-left-corner { content: "" } } @page :first { margin: 2cm } @page cover-page { @top-center { content: none } }',
      '@page{@bottom-center{content:counter(page)" / "counter(pages)}', '@top-left-corner', '@page :first{margin:2cm}', '@page cover-page'
    )
  })

  it('@media print, @supports, @container, @layer, nesting', () => {
    expectKept(
      '@media print { .paged-doc { font-size: 10pt } } @supports (display: grid) { .x { display: grid } } @container (width > 400px) { p { margin: 0 } } @layer base, theme; a { & b { color: red } }',
      '@media print', '@supports (display:grid)', '@container', '@layer base,theme', '&'
    )
  })

  it('@keyframes (incl. vendor-prefixed) and @font-feature-values', () => {
    expectKept(
      '@keyframes fade { from { opacity: 0 } to { opacity: 1 } } @-webkit-keyframes fade { 0% { opacity: 0 } } @font-feature-values Font One { @styleset { nice-style: 12 } }',
      '@keyframes fade', '@-webkit-keyframes fade', '@font-feature-values', '@styleset'
    )
  })

  it('paged-media functions (leader, target-counter, string) with strings', () => {
    expectKept(
      'a::after { content: leader(".") target-counter(attr(href), page) } h1 { string-set: chapter content(text) }',
      'leader(".")', 'target-counter(attr(href),page)'
    )
  })

  it('custom properties + var()', () => {
    expectKept(':root { --accent: #b5371f } h1 { color: var(--accent, red) }', '--accent:#b5371f', 'var(--accent,red)')
  })

  it('own uploads: relative path, quoted, app-origin absolute (normalised)', () => {
    const r = expectKept(
      'p { background: url(/api/files/doc1/abc_12-X.png) } q { background-image: url("/api/files/doc1/x.webp") } s { background: url(https://app.test/api/files/doc1/y.jpg) }',
      'url(/api/files/doc1/abc_12-X.png)', 'url(/api/files/doc1/x.webp)', 'url(/api/files/doc1/y.jpg)'
    )
    expect(r.css).not.toContain('app.test')
    expect(r.urls.sort()).toEqual(['/api/files/doc1/abc_12-X.png', '/api/files/doc1/x.webp', '/api/files/doc1/y.jpg'])
  })

  it('base64 raster data URLs', () => {
    for (const type of ['png', 'jpeg', 'gif', 'webp']) {
      expectKept(`p { background: url(data:image/${type};base64,AAAA) }`, `data:image/${type};base64,AAAA`)
    }
  })

  it('image-set() with own uploads', () => {
    expectKept('p { background-image: image-set("/api/files/doc1/a.png" 1x, url(/api/files/doc1/b.png) 2x) }', 'image-set("/api/files/doc1/a.png"1x,url(/api/files/doc1/b.png)2x)')
  })

  it('fileUrl maps own uploads (render page token)', () => {
    const r = run('p { background: url(/api/files/doc1/a.png) }', { ...OPTS, fileUrl: path => `${path}?token=abc.def` })
    expect(r.css).toContain('/api/files/doc1/a.png?token=abc.def')
  })

  it('@charset is dropped silently', () => {
    const r = run('@charset "utf-8"; p { color: red }')
    expect(r.issues).toEqual([])
    expect(r.css).toBe('p{color:red}')
  })

  it('output is re-serialised, never the raw input (comments + formatting gone)', () => {
    const r = run('/* hello */\np   {\n  color :  red ;\n}\n')
    expect(r.css).toBe('p{color:red}')
  })
})

describe('forbidden at-rules', () => {
  it.each([
    ['@import "x.css";'],
    ['@import url(http://evil.test/x.css);'],
    ['@IMPORT "x.css";'],
    [String.raw`@\69mport "x.css";`],
    ['@namespace svg url(http://www.w3.org/2000/svg);'],
    ['@font-face { font-family: x; src: url(/api/files/doc1/a.png) }'],
    ['@property --x { syntax: "<color>"; inherits: false; initial-value: red }'],
    ['@counter-style x { symbols: url(http://evil.test/a.png) }'],
    ['@-moz-document url-prefix() { p { color: red } }']
  ])('%s', (css) => {
    const r = expectRejected(css, 'at-rule', /@import|@namespace|@font-face|@property|@counter-style|document|evil/i)
    expect(r.css).not.toMatch(/url\(/)
  })

  it('nested inside @media / @supports', () => {
    expectRejected('@media print { @import "x.css"; p { color: red } }', 'at-rule', /@import/)
    expectRejected('@supports (display:grid) { @font-face { font-family: x } }', 'at-rule', /@font-face/)
  })

  it('a forbidden at-rule does not take sibling rules with it', () => {
    const r = run('@import "x.css"; p { color: red }')
    expect(r.css).toBe('p{color:red}')
  })
})

describe('forbidden urls', () => {
  it.each([
    'p { background: url(http://evil.test/a.png) }',
    'p { background: url("https://evil.test/a.png") }',
    'p { background: url(//evil.test/a.png) }',
    'p { background: url(a.png) }',
    'p { background: url(../api/files/doc1/a.png) }',
    'p { background: URL(http://evil.test/a.png) }',
    'p { background: uRl( "http://evil.test/a.png" ) }',
    'p { cursor: url(http://evil.test/c.cur), auto }',
    'p { list-style: url(http://evil.test/a.png) }',
    'p { background: url(/api/files/doc1/a.png?x=1) }',
    'p { background: url(/api/files/doc1/a.svg) }',
    'p { background: url(/api/files/doc1/../doc2/a.png) }',
    'p { background: url(https://other.test/api/files/doc1/a.png) }',
    'p { background: url("data:text/html,<script>alert(1)</script>") }',
    'p { background: url(data:image/png,notbase64) }',
    'p { background-image: image-set("http://evil.test/a.png" 1x) }',
    'p { background-image: -webkit-image-set("http://evil.test/a.png" 1x) }',
    'p { background-image: image("http://evil.test/a.png") }',
    'p { background-image: cross-fade(url(http://evil.test/a.png), url(/api/files/doc1/a.png), 50%) }'
  ])('%s', (css) => {
    const r = expectRejected(css, 'url', /evil|http|data:text|\.\.|\?x=|\.svg/)
    expect(r.css).not.toContain('background:url(http')
  })

  it('unbalanced url( with a script scheme is dropped as unreadable', () => {
    for (const css of ['p { background: url(javascript:alert(1)) }', 'p { background: url(data:text/html,<script>alert(1)</script>) }']) {
      const r = run(css)
      expect(r.issues.map(i => i.code), css).toContain('value')
      expect(r.css, css).toBe('p{}')
    }
  })

  it('escape obfuscations: u\\72l(, \\000075rl(, u\\rl( never yield a url', () => {
    for (const css of [
      String.raw`p { background: u\72l(http://evil.test/a.png) }`,
      String.raw`p { background: \000075rl(http://evil.test/a.png) }`,
      String.raw`p { background: \75 rl(http://evil.test/a.png) }`,
      String.raw`p { background: u\rl("http://evil.test/a.png") }`
    ]) {
      const r = run(css)
      expect(r.issues.length, css).toBeGreaterThan(0)
      expect(r.css, css).not.toContain('evil')
    }
  })

  it('comments inside the function do not smuggle a url', () => {
    const r = run('p { background: url/**/(http://evil.test/a.png); color: red } q { background: u/**/rl(http://evil.test/a.png) }')
    expect(r.issues.length).toBeGreaterThan(0)
    expect(r.css).not.toContain('evil')
  })

  it('weird whitespace inside url() is still checked', () => {
    const r = run('p { background: url(\n\t  http://evil.test/a.png  \n) }')
    expect(r.issues.map(i => i.code)).toContain('url')
    expect(r.css).not.toContain('evil')
  })

  it('custom-property values are checked where declared (var() indirection)', () => {
    const r = run(':root { --x: url(http://evil.test/a.png); --ok: 1px } p { background: var(--x) }')
    expect(r.issues.map(i => i.code)).toContain('url')
    expect(r.css).not.toContain('evil')
    expect(r.css).toContain('--ok:1px')
  })

  it('custom property that is not parseable as a value cannot carry a url', () => {
    const r = run(String.raw`:root { --x: {a:u\72l(http://evil.test/a.png)} }`)
    expect(r.css).not.toContain('evil')
  })

  it('nested in @media / @supports / @page', () => {
    for (const css of [
      '@media print { p { background: url(http://evil.test/a.png) } }',
      '@supports (display: grid) { p { background: url(http://evil.test/a.png) } }',
      '@page { @top-center { background: url(http://evil.test/a.png) } }',
      '@media (min-width: 1px) { @supports (display: grid) { :root { --x: url(http://evil.test/a.png) } } }'
    ]) {
      const r = run(css)
      expect(r.issues.map(i => i.code), css).toContain('url')
      expect(r.css, css).not.toContain('evil')
    }
  })

  it('only the offending declaration is removed', () => {
    const r = run('p { color: red; background: url(http://evil.test/a.png); margin: 0 }')
    expect(r.css).toBe('p{color:red;margin:0}')
  })

  it('SVG data URLs are refused (own code, explained)', () => {
    const r = expectRejected('p { background: url(data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=) }', 'svg-data-url', /svg/)
    expect(r.issues[0]?.message).toMatch(/SVG/)
    expectRejected('p { background: url("data:image/svg+xml,<svg onload=alert(1)>") }', 'svg-data-url', /svg/)
  })
})

describe('other documents\' files', () => {
  it('rejects another doc\'s upload for a concrete doc', () => {
    expectRejected('p { background: url(/api/files/doc2/a.png) }', 'other-doc-file', /doc2/)
    expectRejected('p { background: url(https://app.test/api/files/doc2/a.png) }', 'other-doc-file', /doc2/)
    expectRejected('p { background-image: image-set("/api/files/doc2/a.png" 1x) }', 'other-doc-file', /doc2/)
  })

  it('docId null (saved theme / workspace default) accepts any doc\'s upload path', () => {
    const r = run('p { background: url(/api/files/doc2/a.png) }', { docId: null })
    expect(r.issues).toEqual([])
  })
})

describe('script vectors', () => {
  it.each([
    String.raw`p { width: expression(alert(1)) }`,
    String.raw`p { width: e\78pression(alert(1)) }`,
    String.raw`p { width: EXPRESSION(alert(1)) }`
  ])('expression(): %s', (css) => {
    const r = expectRejected(css, 'function', /expression|alert/i)
    expect(r.css).toBe('p{}')
  })

  it.each([
    ['p { behavior: url(x.htc) }', /behavior/],
    ['p { -ms-behavior: url(x.htc) }', /behavior/],
    ['p { -moz-binding: url(http://evil.test/x.xml#x) }', /binding/],
    [String.raw`p { -moz-b\69nding: url(x) }`, /b\\69nding|binding/]
  ])('forbidden property: %s', (css, gone) => {
    const r = run(css)
    expect(r.issues.map(i => i.code)).toContain('property')
    expect(r.css).not.toMatch(gone)
  })

  it.each([
    'p { background: url(javascript:alert\\(1\\)) }',
    'p { background: url("JaVaScRiPt:alert(1)") }',
    'p { background: url("java\tscript:alert(1)") }',
    'p { background: url("vbscript:msgbox(1)") }',
    'p::before { content: "javascript:alert(1)" }',
    String.raw`p::before { content: "java\73 cript:alert(1)" }`,
    String.raw`a[href="javascript:alert(1)"] { color: red }`
  ])('javascript:/vbscript: anywhere: %s', (css) => {
    const r = run(css)
    expect(r.issues.map(i => i.code)).toContain('script-url')
    expect(r.css.toLowerCase()).not.toMatch(/javascript|vbscript|java.?\\73/)
  })
})

describe('HTML breakout', () => {
  const BREAKOUTS = [
    'p::before { content: "</style><script>alert(1)</script>" }',
    'p::before { content: "</STYLE ><img src=x onerror=alert(1)>" }',
    'p::before { content: "<!--" } q::before { content: "-->" }',
    '</style><script>alert(1)</script>',
    '<!-- p { color: red } -->',
    ':root { --x: "</style><script>alert(1)</script>" }',
    String.raw`p::before { content: "\3c /style>\3c script>alert(1)\3c /script>" }`,
    '/*! </style><script>alert(1)</script> */ p { color: red }'
  ]

  it.each(BREAKOUTS)('%s', (css) => {
    const r = run(css)
    expect(r.css).not.toMatch(/<\/style/i)
    expect(r.css).not.toMatch(/<!--/)
    expect(r.css).not.toMatch(/<script/i)
    expect(r.css).not.toContain('<')
  })

  it('a `<` inside a string survives as the equivalent CSS escape', () => {
    const r = run('p::before { content: "a < b" }')
    expect(r.issues).toEqual([])
    expect(r.css).toBe(String.raw`p::before{content:"a \3c  b"}`)
  })

  it('output stays inert when embedded in a real <style> element', () => {
    const r = run(BREAKOUTS.join('\n'))
    const html = `<style>${r.css}</style><p id="after">x</p>`
    // The only `</style` in the document is the one we wrote.
    expect(html.match(/<\/style/gi)).toHaveLength(1)
  })
})

describe('syntax errors + positions', () => {
  it('reports 1-based line/column of the offending construct', () => {
    const r = run('p { color: red }\n\n  @import "x.css";')
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0]).toMatchObject({ code: 'at-rule', line: 3, column: 3, detail: '@import' })
  })

  it('parse errors are issues (write path rejects them)', () => {
    const g = run('}}} garbage {')
    expect(g.issues.map(i => i.code)).toContain('syntax')
    expect(g.css).not.toContain('}}}')
  })

  it('issues are sorted by position', () => {
    const r = run('p { background: url(http://b.test/x.png) }\n@import "a";')
    expect(r.issues.map(i => i.line)).toEqual([1, 2])
  })

  it('formatCustomCssIssues produces line-prefixed messages and caps the list', () => {
    const r = run(Array.from({ length: 8 }, (_, i) => `@import "${i}";`).join('\n'))
    const text = formatCustomCssIssues(r.issues)
    expect(text.split('\n')[0]).toMatch(/^line 1, column 1: @import/)
    expect(text).toContain('(+3 more)')
  })
})

describe('size limit', () => {
  it('accepts exactly the limit', () => {
    const rule = 'p{color:red}'
    const css = rule.repeat(Math.floor(CUSTOM_CSS_MAX_BYTES / rule.length))
    expect(run(css).issues).toEqual([])
  })

  it('rejects over the limit (bytes, not characters) without parsing', () => {
    const r = run(`p::before{content:"${'é'.repeat(CUSTOM_CSS_MAX_BYTES / 2)}"}`)
    expect(r.issues).toEqual([expect.objectContaining({ code: 'too-large' })])
    expect(r.css).toBe('')
  })

  it('schema caps theme.customCss length', () => {
    const ok = DocThemeSchema.safeParse({ ...defaultTheme, customCss: 'p{}' })
    expect(ok.success).toBe(true)
    const big = DocThemeSchema.safeParse({ ...defaultTheme, customCss: 'x'.repeat(CUSTOM_CSS_MAX_BYTES + 1) })
    expect(big.success).toBe(false)
    expect(DocThemeSchema.safeParse({ ...defaultTheme, customCss: 42 }).success).toBe(false)
  })
})

describe('adaptCustomCssToDoc + rewriteCustomCssDocId', () => {
  it('keeps clean CSS verbatim (formatting preserved)', () => {
    const css = '/* mine */\np {\n  color: red;\n}\n'
    expect(adaptCustomCssToDoc(css, { docId: DOC })).toEqual({ css, dropped: [] })
  })

  it('drops rules pointing at another doc', () => {
    const res = adaptCustomCssToDoc('p { color: red; background: url(/api/files/other/a.png) }', { docId: DOC })
    expect(res.css).toBe('p{color:red}')
    expect(res.dropped.map(d => d.code)).toEqual(['other-doc-file'])
  })

  it('undefined / empty pass through', () => {
    expect(adaptCustomCssToDoc(undefined, { docId: DOC })).toEqual({ css: undefined, dropped: [] })
  })

  it('rewrites the doc id in upload paths for duplicates', () => {
    expect(rewriteCustomCssDocId('p{background:url(/api/files/src/a.png)} q{background:url("/api/files/src/b.png")}', 'src', 'dst'))
      .toBe('p{background:url(/api/files/dst/a.png)} q{background:url("/api/files/dst/b.png")}')
  })
})

describe('substitution inside url-taking functions (regression)', () => {
  // A string in a custom property is not a URL where it is declared;
  // `var()` substitutes it into image-set() only in the browser, after
  // the sanitizer ran. So var()/env()/attr() may not appear inside any
  // function whose arguments are URLs.
  it.each([
    'p { --p: "http://evil.test/x.png"; background-image: image-set(var(--p) 1x) }',
    'p { --p: "http://evil.test/x.png"; background-image: -webkit-image-set(var(--p) 1x) }',
    'p { --a: "http://evil.test/x.png"; --b: var(--a); mask-image: image-set(var(--b) 1x) }',
    'p { background-image: image(var(--p)) }',
    'p { background-image: cross-fade(var(--p), url(/api/files/doc1/a.png)) }',
    'p { background-image: src(var(--p)) }',
    'p { background-image: image-set(env(--p) 1x) }',
    'p { background-image: image-set(attr(data-src) 1x) }',
    'p { background-image: -moz-element(var(--p)) }'
  ])('rejects %s', (css) => {
    const r = expectRejected(css, 'function', /(?:image-set|image|cross-fade|src|element)\((?:var|env|attr)\(/)
    expect(r.css).not.toContain('image-set(')
  })

  it('var() outside url-taking functions still works', () => {
    expectKept('p { --c: #123456; --label: "Note"; color: var(--c); content: var(--label) }', 'color:var(--c)', 'content:var(--label)')
  })
})

describe('deeply nested input (regression)', () => {
  it.each([
    ['blocks', '@media all{'.repeat(5000) + 'p{color:red}' + '}'.repeat(5000)],
    ['functions', 'p{width:' + 'calc('.repeat(10000) + '1px' + ')'.repeat(10000) + '}']
  ])('nested %s fail closed with an issue instead of throwing', (_label, css) => {
    let r: ReturnType<typeof run> | undefined
    expect(() => {
      r = run(css)
    }).not.toThrow()
    expect(r?.css).toBe('')
    expect(r?.issues.map(i => i.code)).toContain('syntax')
  })

  it('moderate nesting is still accepted', () => {
    expectKept('@media print { @supports (display: grid) { .a { & .b { width: calc(100% - calc(2px + 1em)) } } } }', 'calc(100% - calc(2px + 1em))')
  })

  it('brackets inside strings and comments do not count as nesting', () => {
    expectKept(`/* ${'('.repeat(100)} */ p { content: "${'{'.repeat(100)}" }`, 'content:')
  })
})

describe('themeToCss integration', () => {
  const runtime = { title: 'T', date: '2026-01-01', tocTitle: 'Contents' }

  it('appends sanitized custom CSS last, so it overrides the theme', () => {
    const custom = run('.paged-doc h1 { color: #123456 }')
    const out = themeToCss(defaultTheme, { ...runtime, customCss: custom })
    expect(out.endsWith('.paged-doc h1{color:#123456}')).toBe(true)
  })

  it('never reads raw theme.customCss', () => {
    const theme = { ...defaultTheme, customCss: '@import "http://evil.test/x.css";' }
    expect(themeToCss(theme, runtime)).not.toContain('evil')
    expect(themeToCss(theme, runtime)).toBe(themeToCss(defaultTheme, runtime))
  })
})
