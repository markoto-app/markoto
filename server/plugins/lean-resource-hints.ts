import { LEAN_RESOURCE_HINTS_FLAG, stripChunkHints } from '../../shared/utils/leanResourceHints'

// Drops the modulepreload + prefetch hints from the head of pages that asked for it
// during their server render (`useLeanResourceHints()`: the public
// marketing pages). Rationale in shared/utils/leanResourceHints.ts.
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('render:html', (html, { event }) => {
    if (event.context[LEAN_RESOURCE_HINTS_FLAG] !== true) return
    html.head = html.head.map(stripChunkHints)
  })
})
