import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { HEADING_SCALE_EXPONENTS, headingScaleSizePt, headingSizePt, themeFontsImport, themeToCss, type ThemeRuntime } from '../../shared/utils/themeToCss'
import { defaultTheme } from '../../shared/utils/defaultTheme'
import { THEME_PRESETS } from '../../shared/utils/themePresets'
import { isValidTheme } from '../../shared/utils/themeValidation'
import { resolveCodeOptions, withThemeDefaults } from '../../shared/utils/themeOptions'
import { HLJS_THEME_COLORS, HLJS_THEMES } from '../../shared/utils/hljsAssets'
import { pageHeightMm } from '../../shared/utils/pageDimensions'
import type { DocTheme } from '../../shared/types/theme'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const runtime: ThemeRuntime = { title: 'T', date: '6 November 2026', tocTitle: 'Contents' }

function clone(t: DocTheme): DocTheme {
  return structuredClone(t)
}

/** A theme as stored before the optional fields existed. */
function legacy(): DocTheme {
  const t = clone(defaultTheme)
  delete t.headings.numbering
  delete t.code.font
  delete t.code.background
  delete t.code.frame
  delete t.code.wrap
  delete t.code.lineNumbers
  delete t.cover.affiliations
  delete t.cover.rules
  delete t.cover.smallCaps
  delete t.headings.levels
  delete t.header.rule
  delete t.footer.rule
  return t
}

describe('heading scale', () => {
  test('h4 = body, h3 = body·s, h2 = body·s², h1 = body·s³', () => {
    expect(HEADING_SCALE_EXPONENTS).toEqual([3, 2, 1, 0, 0, 0])
    const t = clone(defaultTheme)
    t.body.size = 10
    t.headings.scale = 1.25
    expect(headingSizePt(t, 1)).toBeCloseTo(19.53, 2)
    expect(headingSizePt(t, 2)).toBeCloseTo(15.625, 3)
    expect(headingSizePt(t, 3)).toBeCloseTo(12.5, 2)
    expect(headingSizePt(t, 4)).toBe(10)
    expect(headingSizePt(t, 6)).toBe(9)
    expect(themeToCss(t, runtime)).toMatch(/\.paged-doc h1 \{[^}]*font-size: 19\.53pt/)
  })

  // The scale's h1; a format preset may set its own h1 size per level
  // (arXiv: 1.2× body) — see the per-level tests in themeVariables.test.ts.
  test('every preset scale puts h1 between 1.6× and 2.2× its body size', () => {
    for (const p of THEME_PRESETS) {
      const ratio = headingScaleSizePt(p.theme, 1) / p.theme.body.size
      expect(ratio, p.id).toBeGreaterThanOrEqual(1.6)
      expect(ratio, p.id).toBeLessThanOrEqual(2.2)
    }
  })

  test('a heading is closer to what follows than to what precedes', () => {
    const css = themeToCss(defaultTheme, runtime)
    for (let l = 1; l <= 4; l++) {
      const m = new RegExp(String.raw`\.paged-doc h${l} \{[^}]*margin-top: ([\d.]+)pt;\s*margin-bottom: ([\d.]+)pt`).exec(css)
      expect(m, `h${l}`).not.toBeNull()
      expect(Number(m?.[1])).toBeGreaterThan(Number(m?.[2]) * 2)
    }
  })
})

describe('paged.js selector constraint', () => {
  // paged.js splits selector lists at every comma; a comma inside :is() /
  // :not() / :has() breaks its querySelectorAll and the whole render.
  test('no generated selector has a comma inside parentheses', () => {
    const themes: DocTheme[] = THEME_PRESETS.map(p => withThemeDefaults(p.theme))
    const numbered = clone(defaultTheme)
    numbered.headings.numbering = 'decimal'
    numbered.code.lineNumbers = true
    numbered.cover.layout = 'title-block'
    themes.push(numbered)
    for (const t of themes) {
      const css = themeToCss(t, runtime)
      for (const m of css.matchAll(/(^|\})\s*([^{}@]+)\{/g)) {
        const selector = m[2] ?? ''
        expect(/\([^()]*,[^()]*\)/.test(selector.replace(/url\([^)]*\)/g, '')), selector).toBe(false)
      }
    }
  })
})

describe('optional fields (stored themes without them)', () => {
  test('a legacy theme still validates and renders with the defaults', () => {
    const t = legacy()
    expect(isValidTheme(t)).toBe(true)
    expect(resolveCodeOptions(t)).toEqual({ font: null, background: 'auto', frame: 'none', wrap: true, lineNumbers: false })
    const css = themeToCss(t, runtime)
    expect(css).toContain('white-space: pre-wrap;')
    expect(css).not.toContain('counter-increment: mk-h1')
  })

  test('withThemeDefaults fills them without touching the input', () => {
    const t = legacy()
    const filled = withThemeDefaults(t)
    expect(filled.headings.numbering).toBe('none')
    expect(filled.code.frame).toBe('none')
    expect(filled.cover.affiliations).toEqual([])
    expect(isValidTheme(filled)).toBe(true)
    expect(t.code.frame).toBeUndefined()
  })

  test('invalid values are rejected', () => {
    const t = clone(defaultTheme)
    expect(isValidTheme({ ...t, code: { ...t.code, frame: 'double' } })).toBe(false)
    expect(isValidTheme({ ...t, headings: { ...t.headings, numbering: 'roman' } })).toBe(false)
    expect(isValidTheme({ ...t, cover: { ...t.cover, affiliations: ['x'.repeat(301)] } })).toBe(false)
    expect(isValidTheme({ ...t, code: { ...t.code, font: 'Bad"Font' } })).toBe(false)
  })

  test('every preset spells out every optional field', () => {
    for (const p of THEME_PRESETS) {
      expect(p.theme, p.id).toEqual(withThemeDefaults(p.theme))
      expect(isValidTheme(p.theme), p.id).toBe(true)
    }
  })
})

describe('A5 pages', () => {
  test('valid, 148 × 210 mm', () => {
    const t = clone(defaultTheme)
    t.page.size = 'A5'
    expect(isValidTheme(t)).toBe(true)
    expect(pageHeightMm('A5', 'portrait')).toBe(210)
    expect(pageHeightMm('A5', 'landscape')).toBe(148)
    expect(themeToCss(t, runtime)).toContain('size: A5 portrait;')
  })
})

describe('code blocks', () => {
  test('dark highlight themes keep their background; light ones get a tint', () => {
    const dark = clone(defaultTheme)
    dark.code.theme = 'github-dark'
    expect(themeToCss(dark, runtime)).toMatch(/\.paged-doc pre \{[^}]*background: #0d1117;[^}]*color: #c9d1d9;/)
    const light = clone(defaultTheme)
    light.code.theme = 'github-light'
    expect(themeToCss(light, runtime)).toMatch(/\.paged-doc pre \{[^}]*background: color-mix\(in srgb, var\(--doc-text\) 5%, var\(--doc-bg\)\)/)
    light.code.background = 'none'
    expect(themeToCss(light, runtime)).toMatch(/\.paged-doc pre \{[^}]*background: transparent;/)
    light.code.theme = 'solarized-light'
    light.code.background = 'auto'
    expect(themeToCss(light, runtime)).toMatch(/\.paged-doc pre \{[^}]*background: #fdf6e3;/)
  })

  test('frame, wrap, line numbers, code font', () => {
    const t = clone(defaultTheme)
    t.code.frame = 'rule'
    expect(themeToCss(t, runtime)).toMatch(/\.paged-doc pre \{[^}]*border-left: 3px solid var\(--doc-brand\)/)
    t.code.frame = 'box'
    expect(themeToCss(t, runtime)).toMatch(/\.paged-doc pre \{[^}]*border: 0\.75pt solid/)
    t.code.wrap = false
    expect(themeToCss(t, runtime)).toMatch(/\.paged-doc pre \{[^}]*white-space: pre;/)
    expect(themeToCss(t, runtime)).not.toContain('content: attr(data-line)')
    t.code.lineNumbers = true
    expect(themeToCss(t, runtime)).toContain('content: attr(data-line)')
    t.code.font = 'Latin Modern Mono'
    expect(themeToCss(t, runtime)).toMatch(/\.paged-doc pre \{\s*font-family: "Latin Modern Mono", ui-monospace/)
    expect(themeFontsImport(t)).toContain('/vendor/fonts/latin-modern-mono.css')
  })

  test('short blocks stay whole, long ones may split', () => {
    expect(themeToCss(defaultTheme, runtime)).toContain('.paged-doc pre:not(:has(.code-line:nth-of-type(16)))')
  })

  test('the base colours match the highlight.js stylesheets', () => {
    for (const [name, colors] of Object.entries(HLJS_THEME_COLORS)) {
      const entry = Object.entries(HLJS_THEMES).find(([n]) => n === name)?.[1]
      expect(entry, name).toBeDefined()
      const css = readFileSync(join(ROOT, 'node_modules/highlight.js/styles', `${entry?.path}.min.css`), 'utf8')
      const block = /\.hljs\{((?:color|background)[^}]*)\}/.exec(css)?.[1] ?? ''
      const bg = /background:(#[0-9a-f]+)/i.exec(block)?.[1] ?? ''
      const fg = /color:(#[0-9a-f]+)/i.exec(block)?.[1] ?? ''
      const long = (hex: string) => hex.length === 4 ? `#${[...hex.slice(1)].map(c => c + c).join('')}` : hex
      expect(long(bg).toLowerCase(), `${name} background`).toBe(colors.background)
      expect(long(fg).toLowerCase(), `${name} color`).toBe(colors.color)
    }
  })
})

describe('heading numbers', () => {
  test('decimal numbering: counters on h1–h4 and the TOC, never on the cover title or abstract', () => {
    const t = clone(defaultTheme)
    t.headings.numbering = 'decimal'
    const css = themeToCss(t, runtime)
    expect(css).toMatch(/\.paged-doc h1:not\(\.markoto-cover-title\):not\(\.markoto-abstract-heading\):not\(\.unnumbered\) \{\s*counter-increment: mk-h1;\s*counter-reset: mk-h2 mk-h3 mk-h4;/)
    expect(css).toContain('content: counter(mk-h1) "." counter(mk-h2) "." counter(mk-h3);')
    expect(css).toContain('.paged-doc .table-of-contents > ul > li > ul > li:not(.markoto-abstract-entry):not(.markoto-unnumbered-entry)::before')
    t.headings.numbering = 'none'
    expect(themeToCss(t, runtime)).not.toContain('mk-h1')
  })
})

describe('title block', () => {
  test('flows on page 1: no cover page, no running header on page 1', () => {
    const t = clone(defaultTheme)
    t.cover.layout = 'title-block'
    const css = themeToCss(t, runtime)
    expect(css).not.toContain('page: cover-page')
    expect(css).toMatch(/@page :first \{\s*@top-left \{ content: none; \}/)
    expect(css).toContain('.paged-doc .markoto-abstract-title')
    t.cover.rules = true
    t.cover.smallCaps = true
    expect(themeToCss(t, runtime)).toMatch(/\.markoto-title-block \.markoto-cover-title \{[^}]*border-top: 2pt solid[^}]*font-variant-caps: small-caps;/)
  })

  test('the cover page height covers A5', () => {
    const t = clone(defaultTheme)
    t.page.size = 'A5'
    expect(themeToCss(t, runtime)).toContain('height: 210mm;')
  })
})

describe('footnotes', () => {
  test('body font at 0.8 × body size, short rule', () => {
    const t = clone(defaultTheme)
    t.body.size = 10
    const css = themeToCss(t, runtime)
    expect(css).toMatch(/@footnote \{[^}]*background: linear-gradient\([^)]*\) top left \/ 33% 0\.5pt no-repeat;[^}]*font-family: Inter,[^}]*font-size: 8\.00pt/)
  })
})
