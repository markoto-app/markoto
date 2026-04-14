let md: any = null
let purify: any = null

async function initMd() {
  if (md) return

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

  // Import highlight.js theme CSS for syntax coloring
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

  // Open all preview links in a new tab. `rel="noopener noreferrer"` prevents the
  // opened page from reaching back into our window via window.opener.
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
}

export function useMarkdownPreview(source: Ref<string>) {
  const rendered = ref('')
  const ready = ref(false)

  if (import.meta.client) {
    initMd().then(() => {
      ready.value = true
      // Strict allow-list of tags and attributes we actually produce. Anything
      // outside this list is stripped by DOMPurify. Safer than the older
      // default-plus-`ADD_ATTR: ['target']` approach because it fails closed:
      // if markdown-it (or one of the plugins) ever emits something new — a
      // `<form>`, an `<iframe>`, an `on*` handler — it gets dropped instead of
      // sneaking through on the assumption that DOMPurify's defaults are tight
      // enough. Review this list whenever a new markdown-it plugin is added.
      //
      // Tag sources: markdown-it core (headings, paragraphs, code, lists,
      // emphasis, links, images, tables, blockquote, hr, sup/sub via inline
      // tokens), markdown-it-footnote (sup, section, ol+li with ids/classes),
      // markdown-it-container (div wrappers), markdown-it-emoji (raw unicode,
      // no tags), markdown-it-task-lists (input[type=checkbox]).
      const sanitizeOpts = {
        ALLOWED_TAGS: [
          'a', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2',
          'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'li', 'ol', 'p',
          'pre', 's', 'section', 'span', 'strong', 'sub', 'sup', 'table',
          'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul'
        ],
        ALLOWED_ATTR: [
          // Links / media. `target` and `rel` are injected by our custom
          // link_open renderer (noopener noreferrer covers window.opener).
          'href', 'src', 'alt', 'title', 'target', 'rel',
          // Syntax highlighting emits hljs-* classes on <span> / <code>;
          // markdown-it-container adds `class="warning"` etc. on the wrapper.
          'class',
          // markdown-it-footnote emits id= and the href="#fnref-*" refs.
          'id',
          // Task-list checkboxes.
          'type', 'checked', 'disabled'
        ],
        // `http(s):` and `mailto:` only; block `javascript:`, `data:`, etc.
        // DOMPurify's defaults already block javascript:, but being explicit
        // keeps the intent visible in the code.
        ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
      }
      rendered.value = purify.sanitize(md.render(source.value), sanitizeOpts)

      watch(source, (val) => {
        rendered.value = purify.sanitize(md.render(val), sanitizeOpts)
      })
    })
  }

  return { rendered }
}
