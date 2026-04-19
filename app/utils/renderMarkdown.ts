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
 * markdown-it-container (div wrappers), markdown-it-emoji (raw unicode,
 * no tags), markdown-it-task-lists (input[type=checkbox]).
 */

let md: any = null
let purify: any = null
let initPromise: Promise<void> | null = null

async function init(): Promise<void> {
  if (md) return
  if (initPromise) return initPromise

  initPromise = (async () => {
    const [
      { default: MarkdownIt },
      hljsMod,
      { default: DOMPurify },
      taskListsMod,
      emojiMod,
      footnoteMod,
      containerMod
    ] = await Promise.all([
      import('markdown-it'),
      import('highlight.js'),
      import('dompurify'),
      import('markdown-it-task-lists'),
      import('markdown-it-emoji'),
      import('markdown-it-footnote'),
      import('markdown-it-container')
    ])

    // Syntax highlighting CSS — same theme on screen and in PDF.
    await import('highlight.js/styles/github-dark.min.css')

    const hljs = hljsMod.default
    const taskLists = taskListsMod.default || taskListsMod
    const emoji = (emojiMod as any).full || (emojiMod as any).default || emojiMod
    const footnote = footnoteMod.default || footnoteMod
    const container = containerMod.default || containerMod

    md = new MarkdownIt({
      html: false,
      linkify: true,
      typographer: true,
      highlight: (str: string, lang: string) => {
        if (lang && hljs.getLanguage(lang)) {
          try { return hljs.highlight(str, { language: lang }).value } catch {}
        }
        return ''
      }
    })
      .use(taskLists, { enabled: true })
      .use(emoji)
      .use(footnote)
      .use(container, 'warning')
      .use(container, 'info')
      .use(container, 'tip')

    // Open all preview links in a new tab. `rel="noopener noreferrer"`
    // prevents the opened page from reaching back into our window.
    const defaultLinkOpen = md.renderer.rules.link_open
      || ((tokens: any[], idx: number, options: any, _env: any, self: any) => self.renderToken(tokens, idx, options))
    md.renderer.rules.link_open = (tokens: any[], idx: number, options: any, env: any, self: any) => {
      const token = tokens[idx]
      const targetIdx = token.attrIndex('target')
      if (targetIdx < 0) token.attrPush(['target', '_blank'])
      else token.attrs[targetIdx][1] = '_blank'
      const relIdx = token.attrIndex('rel')
      if (relIdx < 0) token.attrPush(['rel', 'noopener noreferrer'])
      else token.attrs[relIdx][1] = 'noopener noreferrer'
      return defaultLinkOpen(tokens, idx, options, env, self)
    }

    purify = DOMPurify
  })()

  return initPromise
}

const SANITIZE_OPTS = {
  ALLOWED_TAGS: [
    'a', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2',
    'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'li', 'ol', 'p',
    'pre', 's', 'section', 'span', 'strong', 'sub', 'sup', 'table',
    'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul'
  ],
  ALLOWED_ATTR: [
    'href', 'src', 'alt', 'title', 'target', 'rel',
    'class',
    'id',
    'type', 'checked', 'disabled'
  ],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
}

/**
 * Render markdown source to sanitized HTML. Initializes the singleton on
 * first call. Browser-only — guard with `import.meta.client` in callers.
 */
export async function renderMarkdown(source: string): Promise<string> {
  await init()
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
    clone.querySelectorAll('.footnote-backref').forEach((a) => a.remove())
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
