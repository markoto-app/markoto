/**
 * markdown-it + DOMPurify pipeline shared by the live paged preview
 * (`useMarkdownPreview`) and the PDF print iframe (`printPdf`), so both
 * use the same security-critical render path. The strict ALLOWED_TAGS /
 * ALLOWED_ATTR allowlist (`sanitizeHtml.ts`) is the XSS boundary: an
 * explicit allowlist fails closed when a markdown-it plugin starts
 * emitting an unexpected tag, which DOMPurify's looser defaults would not.
 *
 * Tag sources: markdown-it core, markdown-it-footnote (sup, section, ol+li
 * with ids/classes), markdown-it-emoji (raw unicode, no tags),
 * markdown-it-task-lists (input[type=checkbox]), @mdit/plugin-alert
 * (div.markdown-alert + p.title), @mdit/plugin-katex (span.katex + MathML
 * when output=htmlAndMathml).
 */

import type MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'
import type Renderer from 'markdown-it/lib/renderer.mjs'
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs'
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs'
import { createGlobalState } from '@vueuse/core'
import { sanitizeRenderedHtml } from './sanitizeHtml'
import { tableAttrsRowPlugin } from './markdownTableAttrs'
import { unnumberedShorthandPlugin } from './markdownUnnumbered'
import { tablePlugin } from './markdownTables'
import { markersPlugin } from './markdownMarkers'

// Plucked from the instance shape so type resolution doesn't depend on
// markdown-it's internal `/lib` path layout.
type MarkdownItOptions = MarkdownIt['options']

interface MarkdownPipeline {
  md: MarkdownIt
}

/**
 * Matches `<!-- pagebreak -->` on its own line and emits an empty
 * `<div class="page-break">` (styled in themeToCss). The HTML-comment
 * marker degrades gracefully: other markdown renderers see a comment and
 * emit nothing, so documents ported elsewhere don't break.
 */
function pagebreakPlugin(md: MarkdownIt): void {
  const re = /^\s*<!--\s*pagebreak\s*-->\s*$/i
  md.block.ruler.before('paragraph', 'pagebreak', (state: StateBlock, startLine: number, _endLine: number, silent: boolean) => {
    const start = state.bMarks[startLine]! + state.tShift[startLine]!
    const max = state.eMarks[startLine]!
    const line = state.src.slice(start, max)
    if (!re.test(line)) return false
    if (silent) return true
    const token = state.push('html_block', '', 0)
    token.content = '<div class="page-break"></div>\n'
    token.map = [startLine, startLine + 1]
    state.line = startLine + 1
    return true
  })
}

/**
 * Strips HTML comments `<!-- ... -->` from rendered output, so private
 * notes stay out of the preview, PDF and shared view (the text stays in
 * the source for editors).
 *
 *   - block: a line (or multi-line range) whose only non-whitespace
 *     content is a comment is consumed entirely.
 *   - inline: a comment mid-paragraph is stripped in place.
 *
 * Must be registered AFTER `pagebreakPlugin`: both insert
 * `before('paragraph', ...)`, so the later `.use()` runs second and the
 * pagebreak rule claims its exact pattern first.
 *
 * An unterminated `<!--` makes the block rule return false; paragraph
 * parsing then escapes the literal `<` because `html: false`.
 */
function commentPlugin(md: MarkdownIt): void {
  md.block.ruler.before('paragraph', 'comment', (state: StateBlock, startLine: number, endLine: number, silent: boolean) => {
    const start = state.bMarks[startLine]! + state.tShift[startLine]!
    const max = state.eMarks[startLine]!
    const firstLine = state.src.slice(start, max)
    if (!firstLine.startsWith('<!--')) return false

    // Single-line case: open + close on the same line. Anything after
    // `-->` other than whitespace means the user wrote an inline
    // comment with surrounding content — let the inline rule handle
    // it inside a paragraph.
    const inlineCloseIdx = firstLine.indexOf('-->', 4)
    if (inlineCloseIdx !== -1) {
      if (firstLine.slice(inlineCloseIdx + 3).trim() !== '') return false
      if (silent) return true
      state.line = startLine + 1
      return true
    }

    // Multi-line: scan ahead for the closing delimiter. The closing
    // line must also end in whitespace (no trailing real content).
    let line = startLine + 1
    while (line < endLine) {
      const lineStart = state.bMarks[line]! + state.tShift[line]!
      const lineEnd = state.eMarks[line]!
      const lineText = state.src.slice(lineStart, lineEnd)
      const closeIdx = lineText.indexOf('-->')
      if (closeIdx !== -1) {
        if (lineText.slice(closeIdx + 3).trim() !== '') return false
        if (silent) return true
        state.line = line + 1
        return true
      }
      line++
    }
    return false
  })

  md.inline.ruler.before('text', 'comment_inline', (state: StateInline, silent: boolean) => {
    if (state.src.codePointAt(state.pos) !== 0x3C /* < */) return false
    if (state.src.slice(state.pos, state.pos + 4) !== '<!--') return false
    const end = state.src.indexOf('-->', state.pos + 4)
    if (end === -1) return false
    if (!silent) {
      // No token pushed: the comment is consumed silently.
    }
    state.pos = end + 3
    return true
  })
}

/**
 * Slugify shared by anchor + toc so heading IDs and TOC link targets
 * agree. Same shape as GitHub's slugger: lowercase, strip punctuation,
 * hyphenate spaces.
 */
function defaultSlugify(s: string): string {
  const slug = s
    .toLowerCase()
    .trim()
    .replace(/[\s\u00A0]+/g, '-')
    .replace(/[^\p{L}\p{N}\-_]/gu, '')
    .replace(/-+/g, '-')
    // No `--` runs remain after the collapse, so stripping a SINGLE
    // leading/trailing dash suffices (`/^-+|-+$/` backtracks super-linearly).
    .replace(/^-|-$/g, '')
  return clobberSafeId(selectorSafeId(slug))
}

/**
 * An id that starts with a digit (heading "2024 results" → `2024-results`)
 * is a valid HTML id but not a valid CSS `#id` selector, and paged.js
 * resolves `target-counter()` / internal links with `querySelector('#…')`
 * without escaping; it throws and the whole preview stays blank. Such
 * slugs get an `h-` prefix.
 */
export function selectorSafeId(slug: string): string {
  return /^\p{N}/u.test(slug) ? `h-${slug}` : slug
}

let clobberProbe: HTMLFormElement | null = null

/**
 * DOMPurify drops an `id` whose value names a property of `document` or of
 * a `<form>` (`SANITIZE_DOM`, DOM-clobbering protection) — `method`,
 * `title`, `action`, `images`, `forms`, `length`, … A heading "Method"
 * would lose its `id="method"`, leaving the TOC link dangling and
 * paged.js's `target-counter()` printing page 0. Such slugs get a
 * `-section` suffix. Checked the way DOMPurify checks, in the same
 * browser; without a DOM (server-side trusted render, no DOMPurify) slugs
 * stay as they are.
 */
export function clobberSafeId(slug: string): string {
  if (!slug || typeof document === 'undefined') return slug
  clobberProbe ??= document.createElement('form')
  return slug in document || slug in clobberProbe ? `${slug}-section` : slug
}

/**
 * Wrap every line of a code block's (highlighted, escaped) HTML in
 * `<span class="code-line" data-line="N">`, closing and re-opening the
 * highlight spans that cross a line break so the markup stays nested.
 * The theme makes each line a block (`display: block`), so the newlines
 * themselves are dropped: paged.js treats whitespace-only text nodes as
 * ignorable and would run all lines together on the second page of a
 * split block. Block lines also give paged.js clean break points, the
 * theme its line numbers (`code.lineNumbers`, `attr(data-line)`) and a
 * line count for the keep-short-blocks-together rule.
 */
export function wrapCodeLines(html: string): string {
  const lines = html.replace(/\n$/, '').split('\n')
  const open: string[] = []
  return lines.map((line, i) => {
    const prefix = open.join('')
    for (const m of line.matchAll(/<span\b[^>]*>|<\/span>/g)) {
      if (m[0].startsWith('</')) open.pop()
      else open.push(m[0])
    }
    return `<span class="code-line" data-line="${i + 1}">${prefix}${line}${'</span>'.repeat(open.length)}</span>`
  }).join('')
}

export const CODE_TOKEN_CLASS = 'markoto-code-token'

/**
 * Inline-code text as escaped HTML with every run of non-space
 * characters in a `markoto-code-token` span (themeToCss: an inline block,
 * so the line breaks only between tokens). Spaces are kept as they are.
 */
export function wrapCodeTokens(content: string, escape: (s: string) => string): string {
  return content.split(/( +)/).map((part) => {
    if (part === '') return ''
    if (part.startsWith(' ')) return part
    return `<span class="${CODE_TOKEN_CLASS}">${escape(part)}</span>`
  }).join('')
}

/**
 * `title="replay.ts"` (or `title='…'` / `title=word`) from a fence's info
 * string after the language — shown as a caption bar above the block.
 */
export function fenceTitle(info: string): string {
  const m = /(?:^|\s)title=(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(info)
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim().slice(0, 200)
}

// Lazy singleton: the factory runs once on first call and every caller
// gets the same Promise.
const useMarkdownPipeline = createGlobalState(async (): Promise<MarkdownPipeline> => {
  const [
    { default: MarkdownIt },
    hljsMod,
    taskListsMod,
    emojiMod,
    footnoteMod,
    { attrs },
    { mark },
    { ins },
    { sub },
    { sup },
    { dl },
    { abbr },
    { figure },
    { imgSize },
    { alert },
    { katex },
    // anchor must be registered BEFORE toc so toc sees stable heading IDs.
    anchorMod,
    tocMod
  ] = await Promise.all([
    import('markdown-it'),
    import('highlight.js'),
    import('markdown-it-task-lists'),
    import('markdown-it-emoji'),
    import('markdown-it-footnote'),
    import('@mdit/plugin-attrs'),
    import('@mdit/plugin-mark'),
    import('@mdit/plugin-ins'),
    import('@mdit/plugin-sub'),
    import('@mdit/plugin-sup'),
    import('@mdit/plugin-dl'),
    import('@mdit/plugin-abbr'),
    import('@mdit/plugin-figure'),
    import('@mdit/plugin-img-size'),
    import('@mdit/plugin-alert'),
    import('@mdit/plugin-katex'),
    import('markdown-it-anchor'),
    import('markdown-it-toc-done-right')
  ])

  // Same highlight theme on screen and in PDF.
  await import('highlight.js/styles/github-dark.min.css')

  // The dependencies ship mixed CJS/ESM shapes that differ by bundler and
  // version (`default`, `full`, or a direct function export); probe them
  // rather than pin one.
  type MaybeDefault<T> = T | { default?: T, full?: T }
  function unwrap<T>(mod: MaybeDefault<T>): T {
    const m = mod as { default?: T, full?: T }
    return (m.full ?? m.default ?? mod) as T
  }

  const hljs = hljsMod.default
  const taskLists = unwrap(taskListsMod)
  const emoji = unwrap(emojiMod)
  const footnote = unwrap(footnoteMod)
  const anchor = unwrap(anchorMod)
  const toc = unwrap(tocMod)

  const md: MarkdownIt = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: true,
    // GFM-style hard wrap: a single newline in a paragraph becomes a
    // <br> (CommonMark would join the lines), matching what users expect.
    breaks: true,
    // Returns the full `<pre><code class="hljs ...">` wrapper (a string
    // starting with `<pre` is used verbatim) so the github-dark
    // stylesheet's `.hljs` background/color rules apply; markdown-it's
    // own wrapper would lack the `.hljs` class.
    highlight: (str: string, lang: string) => {
      const escaped = md?.utils?.escapeHtml?.(str) ?? str
      if (lang && hljs.getLanguage(lang)) {
        try {
          const out = hljs.highlight(str, { language: lang, ignoreIllegals: true }).value
          return `<pre><code class="hljs language-${lang}">${wrapCodeLines(out)}</code></pre>`
        } catch { /* fall through to the plain-class path below */ }
      }
      // Keep the language class even when hljs doesn't know the language:
      // the mermaid pre-processor finds `pre code.language-mermaid` by it.
      const langClass = lang ? ` language-${lang.replace(/[^a-zA-Z0-9_-]/g, '')}` : ''
      // Mermaid source is replaced by the diagram; keep it as plain text.
      const body = lang === 'mermaid' ? escaped : wrapCodeLines(escaped)
      return `<pre><code class="hljs${langClass}">${body}</code></pre>`
    }
  })
    .use(taskLists, { enabled: true })
    .use(emoji)
    .use(footnote)
    .use(attrs)
  // `# References {-}` → class `unnumbered` (Pandoc shorthand for `{.unnumbered}`).
    .use(unnumberedShorthandPlugin)
    .use(mark)
    .use(ins)
    .use(sub)
    .use(sup)
    .use(dl)
    .use(abbr)
    .use(figure, { copyAttrsOnFigure: true })
    .use(imgSize)
  // The 5-kind GitHub set (the plugin default), explicit to keep the contract visible.
    .use(alert, { alertNames: ['note', 'tip', 'important', 'warning', 'caution'] })
  // `htmlAndMathml` gives screen readers / copy-paste the semantic MathML.
  // throwOnError off so a malformed `$\frac{` renders in errorColor
  // instead of failing the whole render.
    .use(katex, {
      output: 'htmlAndMathml',
      throwOnError: false,
      errorColor: '#cc0000',
      strict: false
    })
  // Permalink off: the inserted `¶` glyphs would clutter the printed page.
  // `[[toc]]` renders to `<nav class="table-of-contents">`; h1–h4 (the
  // plugin default is h2/h3) so a structured document gets useful depth.
    .use(anchor, { permalink: false, slugify: defaultSlugify })
    .use(toc, {
      listType: 'ul',
      level: [1, 2, 3, 4],
      containerClass: 'table-of-contents',
      slugify: defaultSlugify
    })
  // `<!-- pagebreak -->` → `<div class="page-break">` for paged.js.
    .use(pagebreakPlugin)
  // Registered AFTER pagebreak (see commentPlugin).
    .use(commentPlugin)
  // `{.class}` on the line right after a table → attributes of the table
  // (instead of an extra empty row). See markdownTableAttrs.ts.
    .use(tableAttrsRowPlugin)
  // `Table: …` next to a table → <caption>; numbers + units in cells
  // never part. See markdownTables.ts.
    .use(tablePlugin)
  // Marker classes for template CSS: bold run-in labels, `METHOD /path`
  // endpoint lines. See markdownMarkers.ts.
    .use(markersPlugin)

  // ```ts title="replay.ts" → a caption bar above the block. The title is
  // escaped text; the wrapper is a plain <div> (allowed by the sanitiser).
  const defaultFence: RenderRule | undefined = md.renderer.rules.fence
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const html = defaultFence ? defaultFence(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options)
    const title = fenceTitle(tokens[idx]?.info ?? '')
    if (!title) return html
    return `<div class="code-block"><div class="code-title">${md.utils.escapeHtml(title)}</div>${html}</div>\n`
  }

  // Inline code: one span per space-separated token, so a long command
  // wraps at its spaces but never inside a token (`--data-urlencode`,
  // `checkout-api` would otherwise break after a hyphen). The spaces stay
  // text between the spans: copying gives the original string.
  md.renderer.rules.code_inline = (tokens, idx, _options, _env, self) => {
    const token = tokens[idx]!
    return `<code${self.renderAttrs(token)}>${wrapCodeTokens(token.content, md.utils.escapeHtml)}</code>`
  }

  // Links open in a new tab; `rel="noopener noreferrer"` stops the opened
  // page from reaching back into our window.
  type RenderRule = (tokens: Token[], idx: number, options: MarkdownItOptions, env: unknown, self: Renderer) => string
  const defaultLinkOpen: RenderRule = md.renderer.rules.link_open
    || ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx]!
    const targetIdx = token.attrIndex('target')
    if (targetIdx < 0) token.attrPush(['target', '_blank'])
    else token.attrs![targetIdx]![1] = '_blank'
    const relIdx = token.attrIndex('rel')
    if (relIdx < 0) token.attrPush(['rel', 'noopener noreferrer'])
    else token.attrs![relIdx]![1] = 'noopener noreferrer'
    return defaultLinkOpen(tokens, idx, options, env, self)
  }

  return { md }
})

/**
 * Render markdown source to sanitized HTML. Initializes the singleton on
 * first call. Browser-only — guard with `import.meta.client` in callers.
 */
export async function renderMarkdown(source: string): Promise<string> {
  const { md } = await useMarkdownPipeline()
  const html = sanitizeRenderedHtml(md.render(source))
  return transformFootnotesForPagedMedia(html)
}

/**
 * Render markdown that is part of THIS REPOSITORY (the `::sample` blocks
 * of content/marketing) to HTML with the same markdown-it pipeline as the
 * preview, on the server too, so the page ships the result as static
 * HTML. On the server the output is not run through DOMPurify (it needs a
 * window); that is safe only because the source is committed content and
 * `html: false` escapes raw HTML in it anyway. Never pass user input.
 * In the browser (client-side navigation) the sanitiser runs as usual.
 * Footnotes stay as markdown-it renders them (a list at the end) — the
 * paged-media transform is a preview/PDF concern.
 */
export async function renderTrustedMarkdown(source: string): Promise<string> {
  const { md } = await useMarkdownPipeline()
  const html = md.render(source)
  return import.meta.client ? sanitizeRenderedHtml(html) : html
}

/**
 * Lift markdown-it-footnote output (all notes collected at the end) into
 * inline `float: footnote` anchors so paged.js places each footnote at the
 * bottom of the page where its reference appears.
 *
 * markdown-it-footnote emits two pieces:
 *   - inline:  <sup class="footnote-ref"><a href="#fn1" id="fnref1">[1]</a></sup>
 *   - end:     <section class="footnotes"><ol><li id="fn1">…</li></ol></section>
 *
 * Each `<li>`'s content (minus the back-reference link) is wrapped in
 * `<span class="footnote">` at the original `<sup>` location and the
 * trailing section is dropped. themeToCss gives `.footnote` its
 * `float: footnote`. Without footnotes the input is returned untouched.
 */
function transformFootnotesForPagedMedia(html: string): string {
  if (!html.includes('footnote-ref')) return html

  const parser = new DOMParser()
  const doc = parser.parseFromString(`<body><div id="root">${html}</div></body>`, 'text/html')
  const root = doc.getElementById('root')
  if (!root) return html

  const section = root.querySelector('section.footnotes')
  if (!section) return html

  // id → inline content. The back-reference link is meaningless once
  // footnotes are inlined.
  const contents = new Map<string, string>()
  section.querySelectorAll('li.footnote-item').forEach((li) => {
    const id = li.id
    if (!id) return
    const clone = li.cloneNode(true) as Element
    clone.querySelectorAll('.footnote-backref').forEach(a => a.remove())
    // Use the wrapping <p>'s content to keep inline footnotes flat.
    const inner = clone.querySelector('p')
    contents.set(id, (inner ?? clone).innerHTML.trim())
  })

  root.querySelectorAll('sup.footnote-ref').forEach((sup) => {
    const link = sup.querySelector('a')
    const href = link?.getAttribute('href')
    if (href?.charAt(0) !== '#') return
    const targetId = href.slice(1)
    const content = contents.get(targetId)
    if (!content) return
    const span = doc.createElement('span')
    span.className = 'footnote'
    span.innerHTML = content
    sup.replaceWith(span)
  })

  section.remove()
  // The separator markdown-it-footnote puts before the (now removed)
  // footnote list would otherwise print as a stray rule at the very end.
  root.querySelectorAll('hr.footnotes-sep').forEach(hr => hr.remove())
  return root.innerHTML
}
