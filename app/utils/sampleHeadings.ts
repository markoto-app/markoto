// Rendered Markdown samples on marketing pages (`::sample`, the static
// stage of `::try-it`) show headings like "# Quarterly report". Kept as
// <h1>…<h6>, they would become headings of the PAGE: a second <h1> and an
// outline that jumps levels, which confuses search engines and screen
// readers alike. They are examples, so they render as styled <div>s
// (`mk-sample-h mk-sample-h<level>`) with their other attributes (ids for
// `[[toc]]` links, attrs-plugin classes) kept.

const HEADING_TAG = /<(\/?)h([1-6])(\s[^>]*)?>/gi
const CLASS_ATTR = /\sclass="([^"]*)"/i

/** `<h2 id="x">Hi</h2>` → `<div class="mk-sample-h mk-sample-h2" id="x">Hi</div>`. */
export function sampleHeadingsToDivs(html: string): string {
  return html.replace(HEADING_TAG, (_match, close: string, level: string, attrs: string | undefined) => {
    if (close) return '</div>'
    const ours = `mk-sample-h mk-sample-h${level}`
    const rest = attrs ?? ''
    const existing = CLASS_ATTR.exec(rest)
    if (existing) return `<div${rest.replace(CLASS_ATTR, ` class="${ours} ${existing[1] ?? ''}"`)}>`
    return `<div class="${ours}"${rest}>`
  })
}
