// Minimal module declarations for the markdown-it plugins we use. Upstream
// ships either no types (task-lists, emoji, footnote) or ESM-only types that
// the TS resolver rejects at our module settings (container). We don't need
// typed options: these plugins are just handed to markdown-it's `.use()`.
//
// If one of these ever ships proper types, delete the corresponding block.

declare module 'markdown-it-task-lists' {
  import type { MarkdownIt } from 'markdown-it'

  const plugin: (md: MarkdownIt, options?: { enabled?: boolean, label?: boolean, labelAfter?: boolean }) => void
  export default plugin
}

declare module 'markdown-it-emoji' {
  import type { MarkdownIt } from 'markdown-it'
  // Upstream exports both `full` and `light`; we pick at runtime.
  export const full: (md: MarkdownIt, options?: unknown) => void
  export const light: (md: MarkdownIt, options?: unknown) => void
  const plugin: (md: MarkdownIt, options?: unknown) => void
  export default plugin
}

declare module 'markdown-it-footnote' {
  import type { MarkdownIt } from 'markdown-it'

  const plugin: (md: MarkdownIt) => void
  export default plugin
}

declare module 'markdown-it-container' {
  import type { MarkdownIt } from 'markdown-it'

  const plugin: (md: MarkdownIt, options?: {
    validate?: (params: string) => boolean
    render?: (tokens: unknown[], idx: number) => string
    marker?: string
  }) => void
  export default plugin
}
