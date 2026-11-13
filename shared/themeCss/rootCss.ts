import type { DocTheme } from '../types/theme'
import { codeFontStack } from './codeCss'
import { cssFontStack } from './cssValues'

// The document root: custom properties (colours, fonts, sizes) and the
// column layout.

function columnRules(columns: number, columnGap: number): string {
  if (columns <= 1) return ''
  return `  column-count: ${columns};\n  column-gap: ${columnGap}mm;\n  column-fill: auto;`
}

export function rootBlock(theme: DocTheme): string {
  const { brand, secondary } = theme.color
  const { color: text, background, font, size, lineHeight } = theme.body
  const { columns, columnGap } = theme.layout
  return `.paged-doc {
  --doc-brand: ${brand};
  --doc-secondary: ${secondary};
  --doc-text: ${text};
  --doc-bg: ${background};
  --doc-heading-color: ${theme.headings.color};
${fontVars(theme)}
  font-family: ${cssFontStack(font)};
  font-size: ${size}pt;
  line-height: ${lineHeight};
  color: var(--doc-text);
  background: var(--doc-bg);
${columnRules(columns, columnGap)}
}

/* Paint the entire paged.js page surface in the theme's paper colour
   (not just the inner content rectangle). Without this, cream/beige
   themes only colour the content area while the page sheet underneath
   stays white: visually breaks the "warm paper" effect. \`!important\`
   because paged.js injects its own stylesheet AFTER ours and paints
   a white sheet by default. Scoped to .pagedjs_page only, leaving
   .pagedjs_pagebox alone: to avoid recursing into paged.js's
   internal margin-box layout (which can hang the chunker). */
.pagedjs_page {
  background: ${background} !important;
}

/* The same variables for the margin boxes (running head / foot), which
   are not inside .paged-doc. */
.pagedjs_page {
  --doc-brand: ${brand};
  --doc-secondary: ${secondary};
  --doc-text: ${text};
${fontVars(theme)}
}`
}

/**
 * The author's font + accent choices as custom properties, so template CSS
 * (\`theme.customCss\`) follows them instead of naming a family:
 * \`font-family: var(--doc-heading-font)\`. Documented in
 * docs/contributing/TEMPLATE-WORKFLOW.md.
 */
function fontVars(theme: DocTheme): string {
  return [
    `  --doc-accent: ${theme.color.brand};`,
    `  --doc-body-font: ${cssFontStack(theme.body.font)};`,
    `  --doc-heading-font: ${cssFontStack(theme.headings.font)};`,
    `  --doc-meta-font: ${cssFontStack(theme.meta.font)};`,
    `  --doc-mono-font: ${codeFontStack(theme)};`
  ].join('\n')
}
