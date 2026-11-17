import type { MarkdownIt, StateCore } from 'markdown-it'

/**
 * Pandoc's `{-}` shorthand for `{.unnumbered}` on a heading:
 *
 *     # References {-}
 *
 * `@mdit/plugin-attrs` parses `-` as an attribute NAME (`<h1 -="">`),
 * which the sanitizer would drop. This core rule, right after the attrs
 * rule, turns that attribute on a heading into the `unnumbered` class,
 * nothing else: on other elements the stray attribute is left for the
 * sanitizer to remove as before. Unnumbered headings get no section
 * number and don't advance the counters (themeToCss `numberingBlock`).
 */
function unnumberedShorthand(state: StateCore): void {
  for (const token of state.tokens) {
    if (token.type !== 'heading_open' || !token.attrs) continue
    const before = token.attrs.length
    token.attrs = token.attrs.filter(([name]) => name !== '-')
    if (token.attrs.length !== before) token.attrJoin('class', 'unnumbered')
  }
}

export function unnumberedShorthandPlugin(md: MarkdownIt): void {
  md.core.ruler.after('attrs', 'unnumbered_shorthand', unnumberedShorthand)
}
