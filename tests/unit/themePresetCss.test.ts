import { describe, expect, test } from 'vitest'
import { THEME_PRESETS, themeFromPreset } from '../../shared/utils/themePresets'
import { sanitizeCustomCss } from '../../shared/utils/customCss'
import { themeToCss } from '../../shared/utils/themeToCss'
import { isValidTheme } from '../../shared/utils/themeValidation'

// A preset may carry template CSS (`theme.customCss`, arXiv). It is
// ordinary custom CSS: the same sanitizer runs on it at write and render
// time, so it must come through without a single issue. And it must keep
// the rules the engine relies on (docs/TEMPLATE-WORKFLOW.md).

const withCss = THEME_PRESETS.filter(p => p.theme.customCss)

function preset(id: string) {
  const p = THEME_PRESETS.find(x => x.id === id)
  if (!p) throw new Error(`${id} preset missing`)
  return p
}

describe('preset template CSS', () => {
  test('arxiv carries template CSS', () => {
    expect(withCss.map(p => p.id)).toContain('arxiv')
  })

  test('passes the custom-CSS sanitizer without issues and survives it', () => {
    for (const p of withCss) {
      const result = sanitizeCustomCss(p.theme.customCss ?? '', { docId: 'doc1', allowedOrigins: [] })
      expect(result.issues, p.id).toEqual([])
      expect(result.css, p.id).toContain('.paged-doc')
      const css = themeToCss(p.theme, { title: 'T', date: 'd', tocTitle: 'Contents', customCss: result })
      expect(css.endsWith(result.css), p.id).toBe(true)
    }
  })

  test('follows the template CSS rules: scoped selectors, no @page margin boxes, no counter-reset, no commas inside :is/:not/:has', () => {
    for (const p of withCss) {
      const css = (p.theme.customCss ?? '').replace(/\/\*[\s\S]*?\*\//g, '')
      expect(css, p.id).not.toMatch(/@page/)
      expect(css, p.id).not.toMatch(/counter-reset/)
      for (const m of css.matchAll(/(?:^|\})\s*([^{}]+)\{/g)) {
        const selectors = (m[1] ?? '').trim()
        expect(/\([^()]*,[^()]*\)/.test(selectors), selectors).toBe(false)
        for (const sel of selectors.split(',')) {
          expect(sel.trim(), p.id).toMatch(/^\.(paged-doc|pagedjs_pages) /)
        }
      }
    }
  })
})

describe('themeFromPreset', () => {
  const arxiv = preset('arxiv')
  const modern = preset('modern')
  const template = arxiv.theme.customCss ?? ''

  test('a preset without CSS keeps the document CSS; with none, no field', () => {
    expect(themeFromPreset(modern, '.paged-doc p { color: red; }').customCss).toBe('.paged-doc p { color: red; }')
    expect('customCss' in themeFromPreset(modern, undefined)).toBe(false)
    expect('customCss' in themeFromPreset(modern, '  ')).toBe(false)
  })

  test('template CSS goes in front of the author\'s own CSS (so the author still wins)', () => {
    const t = themeFromPreset(arxiv, '.paged-doc p { color: red; }')
    expect(t.customCss).toBe(`${template.trim()}\n\n.paged-doc p { color: red; }`)
    expect(isValidTheme(t)).toBe(true)
  })

  test('switching presets replaces the previous template CSS instead of stacking it', () => {
    const once = themeFromPreset(arxiv, '.paged-doc p { color: red; }')
    expect(themeFromPreset(arxiv, once.customCss).customCss).toBe(once.customCss)
    expect(themeFromPreset(modern, once.customCss).customCss).toBe('.paged-doc p { color: red; }')
    expect('customCss' in themeFromPreset(modern, themeFromPreset(arxiv, undefined).customCss)).toBe(false)
  })

  test('an edited template is the author\'s CSS now and stays', () => {
    const edited = `${template.trim()}\n.paged-doc h1 { color: blue; }`.replace('opacity: 1', 'opacity: 0.9')
    expect(themeFromPreset(modern, edited).customCss).toBe(edited)
  })

  test('never shares the preset object', () => {
    const t = themeFromPreset(arxiv, undefined)
    t.body.size = 99
    expect(arxiv.theme.body.size).toBe(10)
  })
})
