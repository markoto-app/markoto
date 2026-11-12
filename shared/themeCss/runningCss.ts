import type { DocTheme, RunningSlots } from '../types/theme'
import { isThemeImageUrl } from '../utils/theme/themeImages'
import { resolvePageMargins, resolveSectionToken, runningRule } from '../utils/theme/themeOptions'
import { cssString, cssFontStack } from './cssValues'
import type { ThemeRuntime } from './runtime'
import { SECTION_STRING } from './sectionCss'

// Running headers and footers: the `@page` margin boxes built from the
// header/footer slot templates, and the optional rule next to the text
// block.

type RunningSlotPosition = 'left' | 'center' | 'right'

export function renderMarginBoxes(theme: DocTheme, slots: RunningSlots, edge: 'top' | 'bottom', runtime: ThemeRuntime, textColor: string, metaFont: string, marginMm: number): string {
  // The optional image (if `imageUrl` is set) wins over text in the slot
  // it lands in: same slot can't show both. Users typically pick one
  // mental model per slot anyway. paged.js margin boxes accept
  // `content: url('...')` per CSS Paged Media; the image inherits the
  // slot's vertical alignment from the @top-X box itself.
  // Only an upload path / bundled asset is emitted (the theme can reach
  // here over Y.js without validation); anything else drops the image.
  const imgSlot = slots.imageUrl && isThemeImageUrl(slots.imageUrl) ? slots.imagePosition : null
  const text: Record<RunningSlotPosition, string> = {
    left: slots.left,
    center: slots.center,
    right: slots.right
  }
  const positions = ['left', 'center', 'right'] as const
  const out: string[] = []
  // With a rule the running text sits next to the text block, the rule
  // between them (see runningRuleBlock): bottom of the header box / top
  // of the footer box, padded past the rule.
  const ruleAlign = runningRule(slots)
    ? edge === 'top'
      ? `
    vertical-align: bottom;
    padding-bottom: ${(runningRuleGapPt(marginMm) + RUNNING_RULE_TEXT_GAP_PT).toFixed(2)}pt;`
      : `
    vertical-align: top;
    padding-top: ${(runningRuleGapPt(marginMm) + RUNNING_RULE_TEXT_GAP_PT).toFixed(2)}pt;`
    : ''
  for (const pos of positions) {
    const boxName = `${edge}-${pos}`
    if (imgSlot === pos) {
      // Image slot: URL serialised as a CSS string (shape-checked
      // above, so this is belt and braces); height pinned in pt so it
      // lines up with the running header's text-size scale.
      const src = runtime.imageUrl ? runtime.imageUrl(slots.imageUrl) : slots.imageUrl
      out.push(`  @${boxName} {
    content: url(${cssString(src)});
    height: ${slots.imageHeight}pt;
    width: auto;${ruleAlign}
  }`)
      continue
    }
    const tpl = text[pos].trim()
    if (!tpl) continue
    out.push(`  @${boxName} {
    content: ${compileTemplate(tpl, theme, runtime)};
    font-family: ${cssFontStack(metaFont)};
    font-size: 9pt;
    color: ${textColor};
    opacity: 0.7;${ruleAlign}
  }`)
  }
  return out.join('\n')
}

/**
 * `header.rule` / `footer.rule`: the distance between the rule and the
 * text block: 0.35 × the page margin (25 pt at a 1in margin, LaTeX's
 * `headsep` in the arXiv style). The running text sits on the far side
 * of the rule, RUNNING_RULE_TEXT_GAP_PT past it (descenders just clear
 * the rule, as fancyhdr draws it).
 */
export function runningRuleGapPt(marginMm: number): number {
  return marginMm * MM_TO_PT * 0.35
}

const MM_TO_PT = 72 / 25.4

const RUNNING_RULE_TEXT_GAP_PT = 2

const RUNNING_RULE_WIDTH_PT = 0.4

/**
 * The running rule spans the whole text width (all three slots), so it
 * is painted on paged.js's margin ROW (`.pagedjs_margin-top` /
 * `-bottom`, exactly as wide as the text block), not on a slot box,
 * which would underline only that slot, and not as a border at the row's
 * edge, which sits a whole margin away from the text. Only for an edge
 * that has running text; never on the first page when the theme has a
 * cover page or title block (both clear the running text there). Works
 * the same in the preview, browser print and the server PDF: they all
 * run paged.js.
 */
export function runningRuleBlock(theme: DocTheme): string {
  const color = theme.body.color
  const margins = resolvePageMargins(theme)
  const page = theme.cover.enabled ? '.pagedjs_page:not(.pagedjs_first_page)' : '.pagedjs_page'
  const rules: string[] = []
  const edges = [['top', theme.header, 'bottom', margins.top], ['bottom', theme.footer, 'top', margins.bottom]] as const
  for (const [edge, slots, side, marginMm] of edges) {
    if (!runningRule(slots) || !hasRunningContent(slots)) continue
    const gap = runningRuleGapPt(marginMm).toFixed(2)
    rules.push(`${page} .pagedjs_margin-${edge} {
  background: linear-gradient(${color}, ${color}) left 0 ${side} ${gap}pt / 100% ${RUNNING_RULE_WIDTH_PT}pt no-repeat;
}`)
  }
  return rules.join('\n')
}

function hasRunningContent(slots: RunningSlots): boolean {
  const image = slots.imageUrl !== '' && isThemeImageUrl(slots.imageUrl)
  return image || [slots.left, slots.center, slots.right].some(t => t.trim() !== '')
}

function compileTemplate(template: string, theme: DocTheme, runtime: ThemeRuntime): string {
  const parts: string[] = []
  const regex = /\{(title|section|author|page|pages|date)\}/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(template)) !== null) {
    if (match.index > lastIndex) {
      parts.push(cssString(template.slice(lastIndex, match.index)))
    }
    parts.push(tokenToCss(match[1] ?? '', theme, runtime))
    lastIndex = regex.lastIndex
  }
  if (lastIndex < template.length) {
    parts.push(cssString(template.slice(lastIndex)))
  }
  return parts.length ? parts.join(' ') : '""'
}

function tokenToCss(token: string, theme: DocTheme, runtime: ThemeRuntime): string {
  switch (token) {
    case 'title': return cssString(runtime.title)
    // The current section heading (sectionStringBlock): the first on the
    // page, or with `header.sectionMode: 'start'` the one the page starts in.
    case 'section': return resolveSectionToken(theme).mode === 'start' ? `string(${SECTION_STRING}, start)` : `string(${SECTION_STRING})`
    case 'author': return cssString(theme.cover.authors.map(a => a.trim()).filter(Boolean).join(', '))
    case 'page': return 'counter(page)'
    case 'pages': return 'counter(pages)'
    case 'date': return cssString(runtime.date)
    default: return '""'
  }
}
