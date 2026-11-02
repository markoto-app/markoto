import { describe, expect, it } from 'vitest'
import { buildMermaidConfig, documentChartPalette, mermaidFontFamily, textColumnWidthPx } from '../../shared/utils/mermaidConfig'
import { contrastRatio, oklabDistance } from '../../shared/utils/themeColors'
import { defaultTheme } from '../../shared/utils/defaultTheme'
import { THEME_PRESETS } from '../../shared/utils/themePresets'
import type { DocTheme } from '../../shared/types/theme'

function theme(patch: (t: DocTheme) => void = () => {}): DocTheme {
  const t = structuredClone(defaultTheme)
  t.body.font = 'IBM Plex Sans'
  t.body.size = 9.5
  t.color.brand = '#0F5E63'
  t.headings.color = '#12324A'
  t.color.secondary = '#8A96A3'
  t.body.background = '#FFFFFF'
  t.body.color = '#1B2430'
  t.mermaid.theme = 'document'
  patch(t)
  return t
}

function vars(cfg: Record<string, unknown>): Record<string, unknown> {
  const v = cfg.themeVariables
  if (typeof v !== 'object' || v === null) throw new Error('no themeVariables')
  return v as Record<string, unknown>
}

describe('buildMermaidConfig', () => {
  it('always uses the body font and never lowers the security level', () => {
    for (const mt of ['document', 'default', 'dark', 'forest', 'neutral', 'base'] as const) {
      const cfg = buildMermaidConfig(theme((t) => {
        t.mermaid.theme = mt
      }))
      expect(cfg.securityLevel).toBe('antiscript')
      expect(cfg.startOnLoad).toBe(false)
      expect(cfg.fontFamily).toBe('"IBM Plex Sans", sans-serif')
      expect(vars(cfg).fontFamily).toBe('"IBM Plex Sans", sans-serif')
      expect(cfg.htmlLabels).toBe(false)
    }
  })

  it('"document" derives the colours from the theme on top of Mermaid\'s base theme', () => {
    const cfg = buildMermaidConfig(theme())
    const v = vars(cfg)
    expect(cfg.theme).toBe('base')
    expect(v.primaryBorderColor).toBe('#0F5E63')
    expect(v.titleColor).toBe('#12324A')
    expect(v.textColor).toBe('#1B2430')
    expect(v.background).toBe('#FFFFFF')
    expect(String(v.pie1).toLowerCase()).toBe('#0f5e63')
    const xy = v.xyChart
    expect(typeof xy === 'object' && xy !== null && 'plotColorPalette' in xy).toBe(true)
  })

  it('an explicit built-in theme keeps Mermaid\'s own colours', () => {
    const cfg = buildMermaidConfig(theme((t) => {
      t.mermaid.theme = 'forest'
    }))
    expect(cfg.theme).toBe('forest')
    expect(vars(cfg).primaryColor).toBeUndefined()
    expect(vars(cfg).pie1).toBeUndefined()
  })

  it('keeps labels at or above the print floor and draws xy-charts one column wide', () => {
    const tiny = buildMermaidConfig(theme((t) => {
      t.body.size = 7
    }))
    expect(vars(tiny).fontSize).toBe('11px')
    const cfg = buildMermaidConfig(theme())
    expect(vars(cfg).fontSize).toBe('13px')
    const xy = cfg.xyChart
    expect(typeof xy === 'object' && xy !== null ? Reflect.get(xy, 'width') : null).toBe(textColumnWidthPx(theme()))
  })

  it('is plain JSON (it travels to the preview iframe in a postMessage)', () => {
    const cfg = buildMermaidConfig(theme())
    expect(JSON.parse(JSON.stringify(cfg))).toEqual(cfg)
  })
})

describe('textColumnWidthPx', () => {
  it('is the text column of the page at 96 dpi', () => {
    expect(textColumnWidthPx(theme((t) => {
      t.page.margin = 20
    }))).toBe(643) // 170 mm
    expect(textColumnWidthPx(theme((t) => {
      t.page.margin = 20
      t.layout.columns = 2
      t.layout.columnGap = 8
    }))).toBe(306) // (170 − 8) / 2 mm
  })
})

describe('mermaidFontFamily', () => {
  it('picks a generic fallback by font category', () => {
    expect(mermaidFontFamily(theme((t) => {
      t.body.font = 'Source Serif 4'
    }))).toBe('"Source Serif 4", serif')
    expect(mermaidFontFamily(theme((t) => {
      t.body.font = 'Some Custom Font'
    }))).toBe('"Some Custom Font", sans-serif')
  })
})

describe('documentChartPalette', () => {
  it('leads with the accent, has distinguishable entries and carries white labels', () => {
    for (const preset of THEME_PRESETS) {
      const palette = documentChartPalette(preset.theme)
      expect(palette.length, preset.id).toBe(12)
      for (let i = 0; i < 6; i++) {
        for (let j = 0; j < i; j++) expect(oklabDistance(palette[i] ?? '', palette[j] ?? ''), `${preset.id} ${i}/${j}`).toBeGreaterThan(0.03)
        // Slice percentages are printed in white on every slice.
        expect(contrastRatio(palette[i] ?? '', '#ffffff'), `${preset.id} ${palette[i]}`).toBeGreaterThanOrEqual(2.9)
      }
    }
  })
})
