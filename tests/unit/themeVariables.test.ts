import { describe, expect, test } from 'vitest'
import { headingSizePt, runningRuleGapPt, themeToCss, type ThemeRuntime } from '../../shared/utils/themeToCss'
import { defaultTheme } from '../../shared/utils/defaultTheme'
import { THEME_PRESETS } from '../../shared/utils/themePresets'
import { isValidTheme } from '../../shared/utils/themeValidation'
import { coverTitleWeight, resolveHeadingLevel, runningRule, withThemeDefaults } from '../../shared/utils/themeOptions'
import type { DocTheme } from '../../shared/types/theme'

// header.rule / footer.rule, headings.levels, cover.titleWeight and the
// `{.unnumbered}` selectors (the variables added after the theme
// foundation). All optional: a theme without them renders as before.

const runtime: ThemeRuntime = { title: 'T', date: '6 November 2026', tocTitle: 'Contents' }

function clone(t: DocTheme): DocTheme {
  return structuredClone(t)
}

/** A theme stored before these fields existed. */
function legacy(): DocTheme {
  const t = clone(defaultTheme)
  delete t.headings.levels
  delete t.header.rule
  delete t.footer.rule
  delete t.cover.titleWeight
  return t
}

describe('absent fields = the old look', () => {
  test('a legacy theme validates and renders exactly like one with the defaults spelled out', () => {
    const t = legacy()
    expect(isValidTheme(t)).toBe(true)
    expect(themeToCss(t, runtime)).toBe(themeToCss(withThemeDefaults(t), runtime))
    expect(runningRule(t.header)).toBe(false)
    expect(coverTitleWeight(t)).toBe(t.headings.weight)
    expect(resolveHeadingLevel(t, 1)).toEqual({ size: null, weight: t.headings.weight, style: 'normal', smallCaps: false, align: 'left' })
  })

  test('withThemeDefaults spells rule + levels out but leaves titleWeight absent (it follows headings.weight)', () => {
    const filled = withThemeDefaults(legacy())
    expect(filled.header.rule).toBe(false)
    expect(filled.footer.rule).toBe(false)
    expect(filled.headings.levels).toEqual({})
    expect('titleWeight' in filled.cover).toBe(false)
  })

  test('no preset other than arxiv changes its CSS through the new fields', () => {
    for (const p of THEME_PRESETS) {
      if (p.id === 'arxiv') continue
      const css = themeToCss(p.theme, runtime)
      const stripped = clone(p.theme)
      delete stripped.headings.levels
      delete stripped.header.rule
      delete stripped.footer.rule
      expect(themeToCss(stripped, runtime), p.id).toBe(css)
      expect(css, p.id).not.toContain('pagedjs_margin-top {')
    }
  })
})

describe('validation', () => {
  test('accepts the new fields within range', () => {
    const t = clone(defaultTheme)
    t.header.rule = true
    t.footer.rule = true
    t.cover.titleWeight = 300
    t.headings.levels = { h1: { size: 1.2, weight: 700, style: 'italic', smallCaps: true }, h4: {} }
    expect(isValidTheme(t)).toBe(true)
  })

  test('rejects out-of-range or unknown values', () => {
    const t = clone(defaultTheme)
    expect(isValidTheme({ ...t, cover: { ...t.cover, titleWeight: 450 } })).toBe(false)
    expect(isValidTheme({ ...t, cover: { ...t.cover, titleWeight: 1000 } })).toBe(false)
    expect(isValidTheme({ ...t, header: { ...t.header, rule: 'yes' } })).toBe(false)
    const levels = (v: unknown) => ({ ...t, headings: { ...t.headings, levels: v } })
    expect(isValidTheme(levels({ h5: { size: 1 } }))).toBe(false)
    expect(isValidTheme(levels({ h1: { size: 0.4 } }))).toBe(false)
    expect(isValidTheme(levels({ h1: { size: 4.5 } }))).toBe(false)
    expect(isValidTheme(levels({ h1: { weight: 750 } }))).toBe(false)
    expect(isValidTheme(levels({ h1: { style: 'oblique' } }))).toBe(false)
    expect(isValidTheme(levels({ h1: { color: '#000' } }))).toBe(false)
  })
})

describe('headings.levels', () => {
  test('a level size replaces the scale for that level only', () => {
    const t = clone(defaultTheme)
    t.body.size = 10
    t.headings.scale = 1.25
    t.headings.levels = { h1: { size: 1.2 }, h3: { size: 1 } }
    expect(headingSizePt(t, 1)).toBeCloseTo(12, 5)
    expect(headingSizePt(t, 2)).toBeCloseTo(15.625, 3)
    expect(headingSizePt(t, 3)).toBe(10)
    const css = themeToCss(t, runtime)
    expect(css).toMatch(/\.paged-doc h1 \{[^}]*font-size: 12\.00pt;/)
    expect(css).toMatch(/\.paged-doc h2 \{[^}]*font-size: 15\.63pt;/)
  })

  test('weight, italic and small caps per level; spacing stays line-based', () => {
    const t = clone(defaultTheme)
    t.headings.weight = 600
    t.headings.levels = { h1: { weight: 400, smallCaps: true }, h2: { style: 'italic' } }
    const css = themeToCss(t, runtime)
    expect(css).toMatch(/\.paged-doc h1 \{[^}]*font-weight: 400;\s*font-variant-caps: small-caps;/)
    expect(css).toMatch(/\.paged-doc h2 \{[^}]*font-weight: 600;\s*font-style: italic;/)
    expect(css).toMatch(/\.paged-doc h3 \{[^}]*font-weight: 600;\s*line-height/)
    const plain = themeToCss(clone(defaultTheme), runtime)
    const marginOf = (c: string) => /\.paged-doc h1 \{[^}]*(margin-top: [\d.]+pt;\s*margin-bottom: [\d.]+pt)/.exec(c)?.[1]
    expect(marginOf(css)).toBe(marginOf(plain))
  })

  test('a per-level h1 look never reaches the cover title (an h1 too)', () => {
    const t = clone(defaultTheme)
    t.headings.levels = { h1: { style: 'italic', smallCaps: true } }
    const css = themeToCss(t, runtime)
    expect(css).toMatch(/\.paged-doc \.markoto-cover-title \{[^}]*font-style: normal;[^}]*font-variant-caps: normal;/)
  })
})

describe('cover.titleWeight', () => {
  test('absent = headings.weight; set = its own weight, every layout', () => {
    const t = clone(defaultTheme)
    t.headings.weight = 700
    expect(themeToCss(t, runtime)).toMatch(/\.paged-doc \.markoto-cover-title \{[^}]*font-weight: 700;/)
    t.cover.titleWeight = 300
    expect(themeToCss(t, runtime)).toMatch(/\.paged-doc \.markoto-cover-title \{[^}]*font-weight: 300;/)
    t.cover.layout = 'title-block'
    expect(themeToCss(t, runtime)).toMatch(/\.markoto-title-block \.markoto-cover-title \{[^}]*font-weight: 300;/)
  })
})

describe('header.rule / footer.rule', () => {
  test('the rule gap is 0.35 × the margin (25 pt at a 1in margin, LaTeX headsep)', () => {
    expect(runningRuleGapPt(25.4)).toBeCloseTo(25.2, 1)
  })

  test('header rule: full-width line on the margin row, header text moved next to it', () => {
    const t = clone(defaultTheme)
    t.cover.enabled = false
    t.page.margin = 25.4
    t.header.center = '{title}'
    t.header.rule = true
    const css = themeToCss(t, runtime)
    expect(css).toMatch(/\.pagedjs_page \.pagedjs_margin-top \{\s*background: linear-gradient\(#14110D, #14110D\) left 0 bottom 25\.20pt \/ 100% 0\.4pt no-repeat;/)
    expect(css).toMatch(/@top-center \{[^}]*vertical-align: bottom;\s*padding-bottom: 27\.20pt;/)
    expect(css).not.toContain('.pagedjs_margin-bottom {')
  })

  test('footer rule: above the footer text', () => {
    const t = clone(defaultTheme)
    t.footer.rule = true
    const css = themeToCss(t, runtime)
    expect(css).toMatch(/\.pagedjs_margin-bottom \{\s*background: linear-gradient\([^)]*\) left 0 top [\d.]+pt/)
    expect(css).toMatch(/@bottom-center \{[^}]*vertical-align: top;\s*padding-top: [\d.]+pt;/)
  })

  test('skips page 1 when the theme has a cover page or title block; nothing without running text', () => {
    const t = clone(defaultTheme)
    t.header.center = '{title}'
    t.header.rule = true
    t.cover.enabled = true
    expect(themeToCss(t, runtime)).toContain('.pagedjs_page:not(.pagedjs_first_page) .pagedjs_margin-top {')
    t.cover.layout = 'title-block'
    expect(themeToCss(t, runtime)).toContain('.pagedjs_page:not(.pagedjs_first_page) .pagedjs_margin-top {')
    t.header.center = ''
    expect(themeToCss(t, runtime)).not.toContain('.pagedjs_margin-top {')
  })

  test('a header image alone counts as running content', () => {
    const t = clone(defaultTheme)
    t.cover.enabled = false
    t.header.rule = true
    t.header.imageUrl = '/markoto-logos/primary-lockup-light.svg'
    expect(themeToCss(t, runtime)).toContain('.pagedjs_page .pagedjs_margin-top {')
  })
})

describe('unnumbered headings', () => {
  test('{.unnumbered} headings and their marked TOC entries are skipped by the counters', () => {
    const t = clone(defaultTheme)
    t.headings.numbering = 'decimal'
    const css = themeToCss(t, runtime)
    expect(css).toMatch(/\.paged-doc h1:not\(\.markoto-cover-title\):not\(\.markoto-abstract-heading\):not\(\.unnumbered\) \{\s*counter-increment: mk-h1;/)
    expect(css).toContain('.paged-doc .table-of-contents > ul > li:not(.markoto-abstract-entry):not(.markoto-unnumbered-entry) {')
    expect(css).not.toMatch(/\.paged-doc h1 \{[^}]*counter-increment/)
  })
})
