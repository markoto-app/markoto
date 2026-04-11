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

  purify = DOMPurify
}

export function useMarkdownPreview(source: Ref<string>) {
  const rendered = ref('')
  const ready = ref(false)

  if (import.meta.client) {
    initMd().then(() => {
      ready.value = true
      rendered.value = purify.sanitize(md.render(source.value))

      watch(source, (val) => {
        rendered.value = purify.sanitize(md.render(val))
      })
    })
  }

  return { rendered }
}
