// Minimal module declarations for the markdown-it plugins we use. Upstream
// ships either no types (task-lists, emoji, footnote) or ESM-only types that
// the TS resolver rejects at our module settings (container). We don't need
// typed options: these plugins are just handed to markdown-it's `.use()`.
//
// If one of these ever ships proper types, delete the corresponding block.

declare module 'markdown-it-task-lists' {
  import type { PluginWithOptions } from 'markdown-it'

  const plugin: PluginWithOptions<{ enabled?: boolean, label?: boolean, labelAfter?: boolean }>
  export default plugin
}

declare module 'markdown-it-emoji' {
  import type { PluginWithOptions } from 'markdown-it'
  // Upstream exports both `full` and `light`; we pick at runtime.
  export const full: PluginWithOptions
  export const light: PluginWithOptions
  const plugin: PluginWithOptions
  export default plugin
}

declare module 'markdown-it-footnote' {
  import type { PluginSimple } from 'markdown-it'

  const plugin: PluginSimple
  export default plugin
}

declare module 'markdown-it-container' {
  import type { PluginWithOptions } from 'markdown-it'

  const plugin: PluginWithOptions<{
    validate?: (params: string) => boolean
    render?: (tokens: unknown[], idx: number) => string
    marker?: string
  }>
  export default plugin
}
