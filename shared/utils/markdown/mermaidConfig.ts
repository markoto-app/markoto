import type { DocTheme } from '../../types/theme'
import { THEME_FONTS } from '../theme/themeFonts'
import { pageWidthMm } from '../theme/pageDimensions'
import { resolvePageMargins } from '../theme/themeOptions'
import { categoricalPalette, mixHex } from '../theme/themeColors'

/**
 * `mermaid.initialize()` config for a document theme. One builder for the
 * three render paths (live preview + browser print run Mermaid inside the
 * sandboxed iframe, the server render page in its own context), so a
 * diagram looks the same everywhere. The result is plain JSON: it travels
 * to the iframe inside the `render` postMessage.
 *
 * What it decides:
 *  - Font: always the document's body font (the rendered SVG is inlined
 *    into the page after pagination, so the web font the page already
 *    loaded applies: see `inlineMermaidSvgs` in mermaidLoader.ts).
 *  - Colours: `mermaid.theme === 'document'` derives every colour from
 *    the theme (accent, heading ink, body text, neutral, paper) on top
 *    of Mermaid's `base` theme, including the pie + xychart palettes. An
 *    explicit built-in theme (`default`, `neutral`, …) keeps Mermaid's
 *    own colours: the picker still wins.
 *  - Size: label sizes follow the body size (never below 11px ≈ 8pt);
 *    xy-charts and gantt charts are drawn exactly one text column wide
 *    so their text is never scaled down, and sequence diagrams are laid
 *    out so four participants fill the column (messages wrap between
 *    them); flowcharts use tighter spacing so org charts fit the column
 *    at a readable size.
 */

/** Smallest label size in CSS px (≈ 8.25pt), the print-legibility floor. */
const MIN_LABEL_PX = 11

/** Participants a sequence diagram fits in one text column before it is scaled down. */
const SEQUENCE_ACTORS_PER_COLUMN = 4
/** Horizontal margin around a sequence diagram (Mermaid's default 50px wastes a tenth of the column). */
const SEQUENCE_MARGIN_X = 8

/** Column width in CSS px (96 dpi) for the theme's page + layout. */
export function textColumnWidthPx(theme: DocTheme): number {
  const pageMm = pageWidthMm(theme.page.size, theme.page.orientation)
  const cols = theme.layout.columns
  const margins = resolvePageMargins(theme)
  const contentMm = pageMm - margins.left - margins.right - (cols - 1) * theme.layout.columnGap
  return Math.max(200, Math.round(((contentMm / cols) / 25.4) * 96))
}

/** Quoted body-font stack with a category-appropriate generic fallback. */
export function mermaidFontFamily(theme: DocTheme): string {
  const name = theme.body.font
  const category = THEME_FONTS.find(f => f.name === name)?.category
  const generic = category === 'serif' ? 'serif' : category === 'mono' ? 'monospace' : 'sans-serif'
  // themeValidation restricts font names to [A-Za-z0-9 ], so quoting is safe.
  return `"${name}", ${generic}`
}

/** The chart palette for a theme (also used by tests). */
export function documentChartPalette(theme: DocTheme): string[] {
  return categoricalPalette({
    accent: theme.color.brand,
    heading: theme.headings.color,
    neutral: theme.color.secondary,
    background: theme.body.background,
    // Slice percentages are printed in white on every slice.
    maxLightness: 0.62
  })
}

function documentThemeVariables(theme: DocTheme, fontFamily: string, px: number): Record<string, unknown> {
  const bg = theme.body.background
  const text = theme.body.color
  const accent = theme.color.brand
  const heading = theme.headings.color
  const neutral = theme.color.secondary
  const palette = documentChartPalette(theme)
  const pick = (i: number) => palette[i % palette.length] ?? accent
  const vars: Record<string, unknown> = {
    background: bg,
    fontFamily,
    fontSize: `${px}px`,
    textColor: text,
    titleColor: heading,
    lineColor: mixHex(text, bg, 0.45),
    primaryColor: mixHex(accent, bg, 0.88),
    primaryBorderColor: accent,
    primaryTextColor: text,
    secondaryColor: mixHex(heading, bg, 0.9),
    secondaryBorderColor: heading,
    secondaryTextColor: text,
    tertiaryColor: mixHex(neutral, bg, 0.85),
    tertiaryBorderColor: neutral,
    tertiaryTextColor: text,
    mainBkg: mixHex(accent, bg, 0.88),
    nodeBorder: accent,
    nodeTextColor: text,
    clusterBkg: mixHex(neutral, bg, 0.92),
    clusterBorder: neutral,
    edgeLabelBackground: bg,
    noteBkgColor: mixHex(accent, bg, 0.92),
    noteBorderColor: accent,
    noteTextColor: text,
    actorBkg: mixHex(accent, bg, 0.88),
    actorBorder: accent,
    actorTextColor: text,
    signalColor: text,
    signalTextColor: text,
    labelBoxBkgColor: mixHex(accent, bg, 0.88),
    labelBoxBorderColor: accent,
    labelTextColor: text,
    pieTitleTextColor: heading,
    pieSectionTextColor: '#ffffff',
    pieLegendTextColor: text,
    pieStrokeColor: bg,
    pieStrokeWidth: '1.5px',
    pieOuterStrokeWidth: '0px',
    pieOpacity: '1',
    xyChart: {
      backgroundColor: bg,
      titleColor: heading,
      dataLabelColor: text,
      legendTextColor: text,
      xAxisTitleColor: text,
      xAxisLabelColor: text,
      xAxisTickColor: neutral,
      xAxisLineColor: neutral,
      yAxisTitleColor: text,
      yAxisLabelColor: text,
      yAxisTickColor: neutral,
      yAxisLineColor: neutral,
      // Bars first (Mermaid colours series in declaration order): a
      // lighter accent so a line drawn over the bars in the heading ink
      // stays visible, then the rest of the palette.
      plotColorPalette: [mixHex(accent, bg, 0.35), heading, ...palette.slice(2)].join(',')
    }
  }
  for (let i = 0; i < 12; i++) {
    vars[`pie${i + 1}`] = pick(i)
    vars[`cScale${i}`] = pick(i)
    vars[`cScaleLabel${i}`] = '#ffffff'
  }
  for (let i = 0; i < 8; i++) {
    vars[`git${i}`] = pick(i)
    vars[`fillType${i}`] = mixHex(pick(i), bg, 0.8)
  }
  return vars
}

/**
 * Sequence diagram geometry: Mermaid sizes the gap between two
 * participants by the longest message between them, so one long message
 * made the whole diagram several columns wide and the page scaled it
 * (with its text) down to ~6pt. With `wrap` on, messages wrap between
 * the lifelines, and participant box + gap are chosen so four of them
 * fill the column exactly; three leave space, five or more get scaled.
 */
export function sequenceLayout(colPx: number, px: number): Record<string, unknown> {
  // n boxes + (n - 1) gaps = the column. A wide gap and a narrower box:
  // a message wraps at the distance between two lifelines, a
  // participant's name only needs its box.
  const n = SEQUENCE_ACTORS_PER_COLUMN
  const available = colPx - 2 * SEQUENCE_MARGIN_X
  const actorMargin = Math.round((available / n) * 0.4)
  const width = Math.max(80, Math.floor((available + actorMargin) / n) - actorMargin)
  return {
    useMaxWidth: false,
    wrap: true,
    width,
    actorMargin,
    // Wrapped text may reach this far past the lifelines on either side.
    wrapPadding: 2,
    diagramMarginX: SEQUENCE_MARGIN_X,
    diagramMarginY: 8,
    height: Math.round(px * 2.6),
    // Space between a (wrapped) message and its arrow: Mermaid measures the
    // text block a little shorter than it draws it, so the last line of a
    // three-line message sat on the arrow with the default 10px.
    boxMargin: Math.round(px * 1.3),
    boxTextMargin: 4,
    noteMargin: 8,
    messageMargin: Math.round(px * 2.4),
    actorFontSize: px,
    messageFontSize: px,
    noteFontSize: px
  }
}

/**
 * Gantt geometry: drawn one text column wide (Mermaid otherwise takes the
 * width of whatever element it renders in, and the page scales the chart
 * down), labels at the body size, bars tall enough for them. A label
 * longer than its bar goes beside it: to the right when the chart leaves
 * room there (the right padding is sized for a short closing label such
 * as "Handover"), else to the left.
 */
export function ganttLayout(colPx: number, px: number): Record<string, unknown> {
  return {
    useMaxWidth: false,
    useWidth: colPx,
    fontSize: px,
    sectionFontSize: px,
    barHeight: Math.round(px * 1.7),
    barGap: Math.max(4, Math.round(px * 0.3)),
    leftPadding: Math.round(px * 6),
    rightPadding: Math.round(px * 8),
    // Mermaid draws the date axis 50px above the bottom and the chart
    // height is 2 × topPadding + the rows: below 50 the last bar sits on
    // the axis labels.
    topPadding: Math.max(50, Math.round(px * 3.6)),
    gridLineStartPadding: Math.round(px * 2.5)
  }
}

/**
 * CSS Mermaid adds to every diagram. Gantt: the axis labels are drawn
 * with a hard-coded `font-size="10"` attribute (CSS wins over it); a
 * label beside its bar gets the document font (the left one has none of
 * its own). No paper-coloured halo (`stroke` + `paint-order`) behind those
 * labels: Chromium's PDF backend cannot embed stroked text as a font and
 * falls back to a Type 3 bitmap font, instead the grid lines are lighter,
 * so a line crossing a label doesn't fight it. The "today" line is hidden, a printed plan shouldn't change with
 * the day it was rendered (and outside the plan's range it was drawn in
 * the page margin).
 */
export function mermaidThemeCss(fontFamily: string, px: number): string {
  const axisPx = Math.max(MIN_LABEL_PX, Math.round(px * 0.85))
  return [
    `.grid .tick text { font-size: ${axisPx}px; }`,
    `.taskTextOutsideLeft, .taskTextOutsideRight { font-family: ${fontFamily}; }`,
    '.grid .tick line { opacity: 0.45; }',
    '.today { display: none; }'
  ].join('\n')
}

export function buildMermaidConfig(theme: DocTheme): Record<string, unknown> {
  const fontFamily = mermaidFontFamily(theme)
  // Body size in px, floored at the print-legibility minimum.
  const px = Math.max(MIN_LABEL_PX, Math.round((theme.body.size * 4) / 3))
  const colPx = textColumnWidthPx(theme)
  const isDocument = theme.mermaid.theme === 'document'
  // Pies are drawn 450px tall and shown smaller (CSS caps them at ~85mm,
  // see themeToCss), so their text is set larger to stay above the floor
  // (legend rows are 22px apart in Mermaid, so the legend can't go big).
  const sizeVariables = {
    fontFamily,
    fontSize: `${px}px`,
    pieTitleTextSize: `${Math.round(px * 1.45)}px`,
    pieSectionTextSize: `${Math.round(px * 1.4)}px`,
    pieLegendTextSize: `${Math.min(17, Math.round(px * 1.3))}px`
  }
  const themeVariables = isDocument
    ? { ...documentThemeVariables(theme, fontFamily, px), ...sizeVariables }
    : sizeVariables
  return {
    startOnLoad: false,
    // antiscript: blocks <script> and javascript: URLs but keeps
    // Mermaid's own <style> block (strict strips it and every shape
    // falls back to black). Rendered content stays isolated: an <img>
    // during layout, and the inlined SVG is sanitised (server page) or
    // lives in the opaque-origin iframe (preview / print).
    securityLevel: 'antiscript',
    theme: isDocument ? 'base' : theme.mermaid.theme,
    fontFamily,
    // Plain SVG <text> labels instead of <foreignObject> HTML (root key
    // for Mermaid 11; `flowchart.htmlLabels` below for older layouts):
    // they serialise as clean XML and survive the SVG sanitiser that
    // inlines diagrams into the page.
    htmlLabels: false,
    themeVariables,
    themeCSS: mermaidThemeCss(fontFamily, px),
    flowchart: {
      htmlLabels: false,
      padding: 10,
      nodeSpacing: 24,
      rankSpacing: 34,
      diagramPadding: 4,
      useMaxWidth: false
    },
    pie: { useMaxWidth: false, textPosition: 0.72 },
    xyChart: {
      useMaxWidth: false,
      width: colPx,
      height: Math.round(colPx * 0.46),
      titleFontSize: Math.round(px * 1.15),
      titlePadding: 8,
      xAxis: { labelFontSize: px, titleFontSize: px, tickWidth: 1, axisLineWidth: 1 },
      yAxis: { labelFontSize: px, titleFontSize: px, tickWidth: 1, axisLineWidth: 1 }
    },
    sequence: { ...sequenceLayout(colPx, px), actorFontFamily: fontFamily, messageFontFamily: fontFamily, noteFontFamily: fontFamily },
    gantt: ganttLayout(colPx, px),
    journey: { useMaxWidth: false },
    timeline: { useMaxWidth: false },
    mindmap: { useMaxWidth: false },
    quadrantChart: { useMaxWidth: false },
    er: { useMaxWidth: false },
    state: { useMaxWidth: false },
    class: { useMaxWidth: false }
  }
}
