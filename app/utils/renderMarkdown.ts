/**
 * markdown-it + DOMPurify pipeline, factored out as a standalone async
 * function so both the live paged preview (`useMarkdownPreview`) and the
 * PDF print iframe (`printPdf`) share the same security-critical render
 * path. The strict ALLOWED_TAGS / ALLOWED_ATTR allowlist below is the XSS
 * boundary — DOMPurify's defaults plus a few additions would be looser; an
 * explicit allowlist fails closed when a future markdown-it plugin starts
 * emitting an unexpected tag.
 *
 * Tag sources: markdown-it core (headings, paragraphs, code, lists,
 * emphasis, links, images, tables, blockquote, hr, sup/sub via inline
 * tokens), markdown-it-footnote (sup, section, ol+li with ids/classes),
 * markdown-it-emoji (raw unicode, no tags), markdown-it-task-lists
 * (input[type=checkbox]), @mdit/plugin-alert (div.markdown-alert + p.title),
 * @mdit/plugin-katex (span.katex + MathML when output=htmlAndMathml).
 */

import type MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'
import type Renderer from 'markdown-it/lib/renderer.mjs'
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs'
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs'
import { createGlobalState } from '@vueuse/core'

// markdown-it exports Options as a nested type under the default class; we
// pluck it from the instance shape so the type resolution doesn't depend on
// the internal `/lib` path layout.
type MarkdownItOptions = MarkdownIt['options']

// Minimal DOMPurify shape — we only touch `.sanitize`. Avoids a direct
// `typeof DOMPurify` import (dompurify v3's default export is both a value
// and a type in its `.d.ts`, which TS rejects as a type annotation).
interface DOMPurifySanitizer {
  sanitize: (source: string, config?: Record<string, unknown>) => string
}

interface MarkdownPipeline {
  md: MarkdownIt
  purify: DOMPurifySanitizer
}

/**
 * Inline markdown-it plugin: matches `<!-- pagebreak -->` on its own
 * line and emits an empty `<div class="page-break">`. The HTML-comment
 * marker degrades gracefully — every other markdown renderer sees a
 * comment and emits nothing, so docs ported elsewhere don't break.
 *
 * The matching CSS rule (`.page-break { break-after: page }`) lives
 * in themeToCss; this plugin is just the source-text → HTML bridge.
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
 * Block + inline plugin: HTML-style comments `<!-- ... -->` are stripped
 * from rendered output. Lets writers leave private notes for themselves
 * — `<!-- TODO: rewrite this -->` — without those notes leaking into
 * the preview, PDF, or shared view. The comment text stays in the
 * markdown source so collaborators with editor access still see it.
 *
 * Two rules:
 *   - block: a line (or multi-line range) whose only non-whitespace
 *     content is a comment is consumed entirely, emitting nothing.
 *   - inline: `<!-- ... -->` mid-paragraph is stripped in place so
 *     surrounding prose flows around the gap.
 *
 * Pagebreak (`<!-- pagebreak -->`) is registered earlier in the chain
 * via `.use(pagebreakPlugin)` first, then `.use(commentPlugin)`. Both
 * insert `before('paragraph', ...)`, which positions the second
 * insertion AFTER the first — so pagebreak runs first and short-circuits
 * its exact pattern before the comment rule sees the line.
 *
 * Unterminated `<!--` (no matching `-->`) returns false from the block
 * rule and falls through to paragraph parsing, where markdown-it
 * escapes the literal `<` because `html: false`.
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
      // No token pushed — the comment is consumed silently.
    }
    state.pos = end + 3
    return true
  })
}

/**
 * Slugify shared by anchor + toc so the heading IDs and the TOC link
 * targets always agree. Lowercase, strip punctuation, hyphenate spaces
 * — same shape as GitHub's slugger so collaborators familiar with
 * GitHub anchors get the same URLs.
 */
function defaultSlugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[\s\u00A0]+/g, '-')
    .replace(/[^\p{L}\p{N}\-_]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// Lazy singleton via createGlobalState: the factory runs once on first
// call and returns the same Promise to every subsequent caller. The
// async work (dynamic imports + plugin registration) is deduplicated
// without manual `if (initPromise) return initPromise` guards.
const useMarkdownPipeline = createGlobalState(async (): Promise<MarkdownPipeline> => {
  const [
    { default: MarkdownIt },
    hljsMod,
    { default: DOMPurify },
    taskListsMod,
    emojiMod,
    footnoteMod,
    // Batch 1 — typography & semantic markup. Each is a named export
    // from `@mdit/plugin-*` and wires through the same `.use()` chain.
    { attrs },
    { mark },
    { ins },
    { sub },
    { sup },
    { dl },
    { abbr },
    { figure },
    { imgSize },
    // Batch 2 — math + GitHub-style alerts.
    { alert },
    { katex },
    // Batch 3 — anchors + auto-TOC. anchor must load BEFORE toc so
    // the toc plugin sees stable heading IDs to link against.
    anchorMod,
    tocMod
  ] = await Promise.all([
    import('markdown-it'),
    import('highlight.js'),
    import('dompurify'),
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

  // Syntax highlighting CSS — same theme on screen and in PDF.
  await import('highlight.js/styles/github-dark.min.css')

  // Dynamic-import unwrapping: the dependencies ship mixed CJS/ESM defaults
  // whose shapes differ by build. Each module has `default`, `full`, or a
  // direct function export depending on bundler + version — we probe the
  // known shapes rather than pin to one.
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
    // GFM-style hard-wrap: a single newline inside a paragraph
    // becomes a <br>. Without this, `a\nb\nc` renders as `a b c`
    // on one line (CommonMark default), which is consistently
    // confusing for users who expect WYSIWYG behavior. Blank-line
    // paragraph breaks still create new paragraphs.
    breaks: true,
    // Return the full `<pre><code class="hljs ...">` wrapper rather
    // than just the inner highlighted spans, so the github-dark
    // stylesheet's `.hljs { background; color; }` rules actually
    // apply. If we returned only the spans (markdown-it's default
    // contract), markdown-it would wrap them in `<pre><code class="
    // language-X">` — without `.hljs`, the base background/color
    // never lands and the result looks half-styled.
    //
    // Returning a string starting with `<pre` tells markdown-it to
    // use it verbatim instead of wrapping again.
    highlight: (str: string, lang: string) => {
      const escaped = md?.utils?.escapeHtml?.(str) ?? str
      if (lang && hljs.getLanguage(lang)) {
        try {
          const out = hljs.highlight(str, { language: lang, ignoreIllegals: true }).value
          return `<pre><code class="hljs language-${lang}">${out}</code></pre>`
        } catch { /* fall through to the plain-class path below */ }
      }
      // Preserve language class even when hljs doesn't recognize the
      // lang — needed for the iframe-side mermaid pre-processor to
      // find `pre code.language-mermaid` blocks. Without this, mermaid
      // (and any future unknown-lang detector) sees `class="hljs"`
      // only and can't tell what kind of block this is.
      const langClass = lang ? ` language-${lang.replace(/[^a-zA-Z0-9_-]/g, '')}` : ''
      return `<pre><code class="hljs${langClass}">${escaped}</code></pre>`
    }
  })
    .use(taskLists, { enabled: true })
    .use(emoji)
    .use(footnote)
  // Batch 1 — typography & semantic markup
    .use(attrs)
    .use(mark)
    .use(ins)
    .use(sub)
    .use(sup)
    .use(dl)
    .use(abbr)
    .use(figure, { copyAttrsOnFigure: true })
    .use(imgSize)
  // Batch 2 — math + GitHub-style alerts.
  // Defaults already match the 5-kind GH set; setting it explicitly
  // here keeps the contract visible at the call site.
    .use(alert, { alertNames: ['note', 'tip', 'important', 'warning', 'caution'] })
  // KaTeX with `htmlAndMathml` so screen readers / copy-paste get the
  // semantic MathML alongside the visually-laid-out HTML. throwOnError
  // off so a malformed `$\frac{`  doesn't 500 the whole render — bad
  // expressions render in errorColor and the rest of the doc carries
  // on. Ref: @mdit/plugin-katex docs.
    .use(katex, {
      output: 'htmlAndMathml',
      throwOnError: false,
      errorColor: '#cc0000',
      strict: false
    })
  // Batch 3 — anchors + auto-TOC. Anchor adds stable `id` attrs to
  // every heading so the TOC links resolve cleanly (and so deep
  // links to specific sections work). Permalink off — the inserted
  // `¶` glyphs would clutter the printed page. TOC plugin renders
  // the `[[toc]]` placeholder into a nested `<nav class="table-of-
  // contents"><ul>…</ul></nav>` from h2/h3 by default; we expose
  // h1–h4 so a user putting a TOC in a structured doc gets useful
  // depth.
    .use(anchor, { permalink: false, slugify: defaultSlugify })
    .use(toc, {
      listType: 'ul',
      level: [1, 2, 3, 4],
      containerClass: 'table-of-contents',
      slugify: defaultSlugify
    })
  // Inline plugin — `<!-- pagebreak -->` on its own line becomes
  // `<div class="page-break"></div>` for paged.js to break on.
    .use(pagebreakPlugin)
  // Comment plugin — strips `<!-- ... -->` from preview/PDF.
  // Registered AFTER pagebreak so the pagebreak rule wins on its
  // exact pattern by registration order.
    .use(commentPlugin)

  // Open all preview links in a new tab. `rel="noopener noreferrer"`
  // prevents the opened page from reaching back into our window.
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

  return { md, purify: DOMPurify }
})

const SANITIZE_OPTS = {
  ALLOWED_TAGS: [
    'a', 'abbr', 'b', 'blockquote', 'br', 'code', 'dd', 'del', 'div', 'dl',
    'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'hr', 'i', 'img', 'input', 'ins', 'li', 'mark', 'nav', 'ol', 'p', 'pre',
    's', 'section', 'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td',
    'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
    // KaTeX MathML output (@mdit/plugin-katex with output=htmlAndMathml).
    // The HTML side is built from spans we already allow; the MathML
    // mirror gives screen readers + copy-paste the semantic tree.
    'math', 'semantics', 'annotation', 'mrow', 'mi', 'mo', 'mn', 'mtext',
    'msup', 'msub', 'msubsup', 'mfrac', 'msqrt', 'mroot', 'mover', 'munder',
    'munderover', 'mspace', 'mstyle', 'mpadded', 'menclose', 'mtable',
    'mtr', 'mtd'
  ],
  ALLOWED_ATTR: [
    'href', 'src', 'alt', 'title', 'target', 'rel',
    'class',
    'id',
    'type', 'checked', 'disabled',
    // img-size emits width/height as bare attrs; figure emits no
    // extra attrs by default but gets them via attrs plugin if used.
    'width', 'height',
    // KaTeX uses inline `style` for vertical alignment of fractions,
    // square roots, etc. — its CSS classes alone don't position the
    // glyph stack. DOMPurify v3 sanitizes style values (strips
    // expression(), url(javascript:…)) so this is safe to allow.
    'style',
    // MathML attributes used by KaTeX's mathml output.
    'mathvariant', 'displaystyle', 'scriptlevel', 'encoding',
    // ARIA + role for KaTeX's a11y wrapping of the HTML rendering.
    'aria-hidden', 'role'
  ],
  // Explicit URI allowlist — strictly more restrictive than DOMPurify's default.
  // Permits:
  //   - http(s) and mailto schemes
  //   - Any URL without a scheme (absolute paths like `/api/files/…`,
  //     protocol-relative `//host/…`, fragments `#anchor`, bare relative
  //     paths like `foo.png`) — the `[^:]*(?:\/|#|$)` branch lets any
  //     string through iff it never reaches a `:` before hitting a path
  //     separator / fragment / end-of-string.
  // Denies:
  //   - data:, javascript:, vbscript:, file:, ftp:, tel:, and every other
  //     scheme — any `:` that isn't part of `https:` or `mailto:` fails.
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|[^:]*(?:\/|#|$))/i
}

/**
 * Render markdown source to sanitized HTML. Initializes the singleton on
 * first call. Browser-only — guard with `import.meta.client` in callers.
 */
export async function renderMarkdown(source: string): Promise<string> {
  const { md, purify } = await useMarkdownPipeline()
  const html = purify.sanitize(md.render(source), SANITIZE_OPTS)
  return transformFootnotesForPagedMedia(html)
}

/**
 * Lift markdown-it-footnote output from "all collected at end of doc" into
 * `float: footnote` inline anchors so paged.js places each footnote at the
 * bottom of the page where its reference appears (the standard print
 * typography convention).
 *
 * markdown-it-footnote emits two pieces:
 *   - inline:  <sup class="footnote-ref"><a href="#fn1" id="fnref1">[1]</a></sup>
 *   - end:     <section class="footnotes"><ol><li id="fn1">…</li></ol></section>
 *
 * We extract each `<li>`'s content (minus the back-reference link), wrap
 * it in `<span class="footnote">…</span>` at the original `<sup>` location,
 * and drop the trailing section. The `.footnote` class then gets
 * `float: footnote` from themeToCss, which paged.js's footnote handler
 * pulls into the page's bottom margin.
 *
 * Falls back gracefully — if there are no footnotes, returns the input
 * untouched.
 */
function transformFootnotesForPagedMedia(html: string): string {
  if (html.indexOf('footnote-ref') === -1) return html

  const parser = new DOMParser()
  const doc = parser.parseFromString(`<body><div id="root">${html}</div></body>`, 'text/html')
  const root = doc.getElementById('root')
  if (!root) return html

  const section = root.querySelector('section.footnotes')
  if (!section) return html

  // Build id → inline-content map. Strip the back-reference link that
  // markdown-it-footnote appends to each item — it links back to the
  // inline ref position, which is meaningless once footnotes are inlined.
  const contents = new Map<string, string>()
  section.querySelectorAll('li.footnote-item').forEach((li) => {
    const id = li.id
    if (!id) return
    const clone = li.cloneNode(true) as Element
    clone.querySelectorAll('.footnote-backref').forEach(a => a.remove())
    // Drop the wrapping <p> if it's the only child — keeps inline footnotes flat.
    const inner = clone.querySelector('p')
    contents.set(id, (inner ?? clone).innerHTML.trim())
  })

  // Inline each reference. The `<sup>` becomes a `<span class="footnote">`
  // whose text content paged.js then floats into the page-bottom margin.
  root.querySelectorAll('sup.footnote-ref').forEach((sup) => {
    const link = sup.querySelector('a')
    const href = link?.getAttribute('href')
    if (!href || href.charAt(0) !== '#') return
    const targetId = href.slice(1)
    const content = contents.get(targetId)
    if (!content) return
    const span = doc.createElement('span')
    span.className = 'footnote'
    span.innerHTML = content
    sup.replaceWith(span)
  })

  section.remove()
  return root.innerHTML
}
