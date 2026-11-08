import { describe, expect, it } from 'vitest'
import { buildMermaidConfig, documentChartPalette, ganttLayout, mermaidFontFamily, mermaidThemeCss, sequenceLayout, textColumnWidthPx } from '../../shared/utils/mermaidConfig'
import { contrastRatio, greyLightness, oklabDistance } from '../../shared/utils/themeColors'
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

function section(cfg: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = cfg[key]
  if (typeof v !== 'object' || v === null) throw new Error(`no ${key}`)
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

describe('documentChartPalette in greyscale', () => {
  it('prints neighbouring pie slices as different greys in every preset', () => {
    for (const preset of THEME_PRESETS) {
      const grey = documentChartPalette(preset.theme).map(greyLightness)
      for (let n = 2; n <= 6; n++) {
        for (let i = 0; i < n; i++) {
          if (n === 2 && i === 1) continue
          const gap = Math.abs((grey[i] ?? 0) - (grey[(i + 1) % n] ?? 0))
          expect(gap, `${preset.id}: ${n} slices, ${i}/${(i + 1) % n}`).toBeGreaterThanOrEqual(n <= 3 ? 0.1 : 0.05)
        }
      }
    }
  })
})

describe('chart geometry', () => {
  const num = (v: unknown) => (typeof v === 'number' ? v : Number.NaN)

  it('lays sequence diagrams out so four participants fill the text column', () => {
    for (const colPx of [300, 642, 900]) {
      const seq = sequenceLayout(colPx, 14)
      const width = num(seq.width)
      const margin = num(seq.actorMargin)
      expect(seq.wrap).toBe(true)
      expect(seq.useMaxWidth).toBe(false)
      expect(seq.messageFontSize).toBe(14)
      expect(seq.actorFontSize).toBe(14)
      expect(seq.noteFontSize).toBe(14)
      const total = 4 * width + 3 * margin + 2 * num(seq.diagramMarginX)
      if (colPx >= 642) expect(Math.abs(total - colPx), `${colPx}`).toBeLessThanOrEqual(4)
      // A message wraps at the distance between lifelines: wider than a box.
      expect(margin).toBeGreaterThan(width * 0.3)
    }
  })

  it('wires the sequence + gantt layout and the document font into the config', () => {
    const cfg = buildMermaidConfig(theme())
    const seq = section(cfg, 'sequence')
    expect(seq.messageFontFamily).toBe('"IBM Plex Sans", sans-serif')
    expect(seq.actorFontFamily).toBe('"IBM Plex Sans", sans-serif')
    const gantt = section(cfg, 'gantt')
    expect(gantt.useWidth).toBe(textColumnWidthPx(theme()))
    expect(String(cfg.themeCSS)).toContain('.grid .tick text')
  })

  it('draws gantt charts one column wide with labels at the body size', () => {
    const g = ganttLayout(642, 14)
    expect(g.useWidth).toBe(642)
    expect(g.fontSize).toBe(14)
    expect(g.sectionFontSize).toBe(14)
    // Bars are taller than their label.
    expect(num(g.barHeight)).toBeGreaterThan(14 * 1.4)
    // The last bar ends at the date axis (drawn 50px above the bottom), not on its labels.
    expect(num(g.topPadding)).toBeGreaterThanOrEqual(50)
    expect(num(ganttLayout(300, 11).topPadding)).toBeGreaterThanOrEqual(50)
    // Room right of the chart for a short closing label ("Handover").
    expect(num(g.rightPadding) - num(g.leftPadding) / 2).toBeGreaterThanOrEqual(70)
  })

  it('sizes gantt axis labels above the legibility floor and hides the render-date line', () => {
    const css = mermaidThemeCss('"Inter", sans-serif', 10)
    expect(css).toContain('.grid .tick text { font-size: 11px; }')
    expect(css).toContain('font-family: "Inter", sans-serif')
    // No stroked text: Chromium prints it as a Type 3 bitmap font.
    expect(css).not.toMatch(/stroke|paint-order/)
    expect(css).toContain('.today { display: none; }')
    expect(mermaidThemeCss('"Inter", sans-serif', 20)).toContain('font-size: 17px')
  })
})
