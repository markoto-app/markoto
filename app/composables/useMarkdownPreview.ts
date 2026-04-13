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
      // ADD_ATTR: ['target'] keeps our target="_blank" on anchors through
      // DOMPurify — it would otherwise strip `target` as a security default.
      // The injected rel="noopener noreferrer" covers the tab-hijack risk.
      const sanitizeOpts = { ADD_ATTR: ['target'] }
      rendered.value = purify.sanitize(md.render(source.value), sanitizeOpts)

      watch(source, (val) => {
        rendered.value = purify.sanitize(md.render(val), sanitizeOpts)
      })
    })
  }

  return { rendered }
}
