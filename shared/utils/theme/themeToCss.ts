import type { DocTheme } from '../../types/theme'
import { fontStylesheetUrls } from './themeFonts'
import { resolveCodeOptions } from './themeOptions'
import type { ThemeRuntime } from '../../themeCss/runtime'
import { breakHints, columnSpanBlock, pageBlock, pageBreakBlock } from '../../themeCss/pageCss'
import { runningRuleBlock } from '../../themeCss/runningCss'
import { rootBlock } from '../../themeCss/rootCss'
import { typographyBlock } from '../../themeCss/typographyCss'
import { tableBlock } from '../../themeCss/tableCss'
import { alertBlock, blockBlock } from '../../themeCss/blocksCss'
import { codeBlock } from '../../themeCss/codeCss'
import { katexBlock, mermaidBlock } from '../../themeCss/mathDiagramCss'
import { tocBlock } from '../../themeCss/tocCss'
import { numberingBlock } from '../../themeCss/numberingCss'
import { captionBlock, referencesBlock } from '../../themeCss/captionCss'
import { sectionStringBlock } from '../../themeCss/sectionCss'
import { coverBlock, repeatTitleBlock } from '../../themeCss/coverCss'

// The theme stylesheet, composed from one module per CSS concern under
// `shared/themeCss/` (outside `shared/utils/`, so its internals are not
// auto-imported into the app and the server). The block order is the cascade order: later blocks win ties,
// and the document's custom CSS comes last so its rules win.

export type { ThemeRuntime } from '../../themeCss/runtime'
export { runningRuleGapPt } from '../../themeCss/runningCss'
export { HEADING_SCALE_EXPONENTS, headingScaleSizePt, headingSizePt } from '../../themeCss/typographyCss'
export { mathFontScale } from '../../themeCss/mathDiagramCss'
export { SECTION_HEADING_CLASS, numberingBaseClass } from '../../themeCss/numberingCss'
export { CAPTION_NUMBER_ATTR } from '../../themeCss/captionCss'
export { SECTION_LABEL_ATTR } from '../../themeCss/sectionCss'

/**
 * Compile a DocTheme into a single CSS stylesheet that drives both the
 * live paged preview and the PDF print iframe.
 */
export function themeToCss(theme: DocTheme, runtime: ThemeRuntime): string {
  const blocks = [
    pageBlock(theme, runtime),
    rootBlock(theme),
    typographyBlock(theme),
    tableBlock(theme),
    blockBlock(theme),
    codeBlock(theme),
    alertBlock(theme),
    katexBlock(theme),
    mermaidBlock(theme),
    tocBlock(theme, runtime),
    numberingBlock(theme, runtime),
    captionBlock(theme, runtime),
    referencesBlock(theme),
    sectionStringBlock(theme),
    runningRuleBlock(theme),
    pageBreakBlock(),
    columnSpanBlock(theme),
    coverBlock(theme),
    repeatTitleBlock(theme),
    breakHints(theme.layout.columns)
  ]
  const custom = runtime.customCss?.css
  if (custom) blocks.push(`/* custom css */\n${custom}`)
  return blocks.join('\n\n')
}

/**
 * `@import` rules for the theme's fonts — one same-origin stylesheet per
 * self-hosted family (shared/utils/theme/themeFonts.ts); a family we don't
 * serve is skipped and renders in the fallback stack. Returned separately
 * so changing a color doesn't trigger a font refetch. The stylesheets
 * only declare @font-face rules: a browser downloads just the weights,
 * styles and unicode-range subsets the document actually uses.
 */
export function themeFontsImport(theme: DocTheme): string {
  return fontStylesheetUrls([theme.body.font, theme.headings.font, theme.meta.font, resolveCodeOptions(theme).font])
    .map(url => `@import url('${url}');`)
    .join('\n')
}
