// Public marketing pages (the product page at `/` for logged-out
// visitors, /pricing and the marketing content pages) ship their HTML
// without Nuxt's chunk hints: `<link rel="modulepreload">` and
// `<link rel="prefetch">`. See `app/composables/useLeanResourceHints.ts`
// for which pages opt in and `server/plugins/lean-resource-hints.ts` for
// the hook.
//
// Why: Nuxt preloads every chunk of the page's import graph (~65 files,
// ~300 KB gzip on `/`) and prefetches every lazy chunk it might load
// later (the new-document dialog, the dashboard, the `::try-it`
// workbench's CodeMirror: up to ~400 KB more), all from the document
// head, so all of it starts downloading next to the stylesheet, the web
// fonts and the hero picture. On a phone connection that bandwidth is
// what the first paint waits for. These pages are fully server-rendered:
// they paint without their JavaScript. Without the hints the entry script
// still loads at once and its imports follow as the browser discovers
// them (hydration a few round trips later, the paint sooner); a lazy
// chunk loads when it is needed (pointer over / focus on a button warms
// the new-document dialog, see useNewDocDialog).

const CHUNK_HINT = /<link\b[^>]*\brel=["']?(?:modulepreload|prefetch)["']?[^>]*>/gi

/** `chunk` without its `<link rel="modulepreload">` / `<link rel="prefetch">` tags. */
export function stripChunkHints(chunk: string): string {
  return chunk.replace(CHUNK_HINT, '')
}

/** Flag on `event.context` set by `useLeanResourceHints()` during the server render. */
export const LEAN_RESOURCE_HINTS_FLAG = 'markotoLeanResourceHints'
