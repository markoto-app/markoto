import type { DocTheme } from '../types/theme'

// Images, blockquotes, horizontal rules and GitHub-style alerts.

export function blockBlock(theme: DocTheme): string {
  const { imageRadius, imageMaxWidth, blockquoteStyle } = theme.blocks
  return [
    `.paged-doc img {
  max-width: ${imageMaxWidth}%;
  height: auto;
  border-radius: ${imageRadius}px;
  margin: 0.8em 0;
}`,
    blockquoteCss(blockquoteStyle)
  ].join('\n')
}

export function hrCss(theme: DocTheme): string {
  const { hrStyle, hrThickness } = theme.blocks
  switch (hrStyle) {
    case 'none':
      // No visible separator, but reserve a margin so the source
      // `---` still creates a visual breath in the page.
      return `.paged-doc hr { border: none; margin: 1.5em 0; height: 0; }`
    case 'asterism':
      // Editorial signature — the Unicode asterism (⁂) centered with
      // generous breathing room. Reads like a Penguin Classics scene
      // break. We sneak it in via ::before because <hr> is a void
      // element and can't have text children directly.
      return `.paged-doc hr { border: none; text-align: center; margin: 2em 0; height: 1em; line-height: 1; }
.paged-doc hr::before { content: '⁂'; color: var(--doc-secondary); font-size: 1.4em; letter-spacing: 0.4em; }`
    case 'dashed':
      return `.paged-doc hr { border: none; border-top: ${hrThickness}px dashed var(--doc-secondary); margin: 1.5em 0; }`
    case 'dotted':
      return `.paged-doc hr { border: none; border-top: ${hrThickness}px dotted var(--doc-secondary); margin: 1.5em 0; }`
    case 'rule':
    default:
      return `.paged-doc hr { border: none; border-top: ${hrThickness}px solid var(--doc-secondary); margin: 1.5em 0; }`
  }
}

function blockquoteCss(variant: DocTheme['blocks']['blockquoteStyle']): string {
  if (variant === 'none') {
    return `.paged-doc blockquote { font-style: italic; margin: 1em 0; padding: 0; }`
  }
  if (variant === 'background') {
    return `.paged-doc blockquote {
  background: color-mix(in srgb, var(--doc-brand) 8%, transparent);
  padding: 0.8em 1em;
  margin: 1em 0;
  border-radius: 4px;
}`
  }
  return `.paged-doc blockquote {
  border-left: 3px solid var(--doc-brand);
  padding-left: 1em;
  margin: 1em 0;
  font-style: italic;
  color: color-mix(in srgb, var(--doc-text) 75%, var(--doc-bg));
}`
}

/**
 * GitHub-style alert blocks emitted by `@mdit/plugin-alert`. Five kinds,
 * each in its own semantic color so the meaning reads at a glance. The
 * palette comes from `theme.alerts.{note|tip|important|warning|caution}`,
 * so each preset sets its own admonition look instead of a fixed
 * blue/green/purple scheme.
 *
 * HTML structure (from the plugin):
 *   <div class="markdown-alert markdown-alert-{kind}">
 *     <p class="markdown-alert-title">Note</p>
 *     <p>...body...</p>
 *   </div>
 */
export function alertBlock(theme: DocTheme): string {
  const { alerts } = theme
  const kinds: Array<{ name: string, color: string }> = [
    { name: 'note', color: alerts.note },
    { name: 'tip', color: alerts.tip },
    { name: 'important', color: alerts.important },
    { name: 'warning', color: alerts.warning },
    { name: 'caution', color: alerts.caution }
  ]
  const variants = kinds.map(k => `.paged-doc .markdown-alert-${k.name} {
  border-left-color: ${k.color};
  background: color-mix(in srgb, ${k.color} 8%, transparent);
}
.paged-doc .markdown-alert-${k.name} .markdown-alert-title {
  color: ${k.color};
}`).join('\n')
  return [
    `.paged-doc .markdown-alert {
  border-left: 4px solid;
  padding: 0.6em 1em;
  margin: 1em 0;
  border-radius: 4px;
  break-inside: avoid;
}`,
    `.paged-doc .markdown-alert > :first-child { margin-top: 0; }`,
    `.paged-doc .markdown-alert > :last-child { margin-bottom: 0; }`,
    `.paged-doc .markdown-alert-title {
  font-weight: 600;
  font-size: 0.9em;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin: 0 0 0.4em 0;
}`,
    variants
  ].join('\n')
}
