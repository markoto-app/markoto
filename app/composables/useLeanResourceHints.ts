import { LEAN_RESOURCE_HINTS_FLAG } from '~~/shared/utils/leanResourceHints'

// Asks the server render to leave Nuxt's `<link rel="modulepreload">` + `prefetch` hints
// out of this page's HTML (server/plugins/lean-resource-hints.ts; why:
// shared/utils/leanResourceHints.ts). For the public marketing pages only:
// fully server-rendered pages a visitor reads before touching anything,
// where the stylesheet, fonts and hero picture should get the connection
// first. Called by layouts/marketing.vue (/pricing + the marketing content
// pages), layouts/docs.vue (/docs/**), the /legal/** pages and
// pages/index.vue while it shows the product tour. Never for app pages
// (editor, dashboard, settings): they need their code at once.
export function useLeanResourceHints(enabled: () => boolean = () => true): void {
  if (!import.meta.server) return
  const event = useRequestEvent()
  if (event && enabled()) event.context[LEAN_RESOURCE_HINTS_FLAG] = true
}
