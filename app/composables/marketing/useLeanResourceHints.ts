import { LEAN_RESOURCE_HINTS_FLAG } from '~~/shared/utils/vendor/leanResourceHints'

// Asks the server render to leave Nuxt's `<link rel="modulepreload">` +
// `prefetch` hints out of this page's HTML (server/plugins/lean-resource-hints.ts;
// why: shared/utils/vendor/leanResourceHints.ts), so the stylesheet, fonts and
// hero picture get the connection first. Only for fully server-rendered public
// pages a visitor reads before touching anything: layouts/marketing.vue,
// layouts/docs.vue, the /legal/** pages and pages/index.vue while it shows the
// product tour. Never for app pages (editor, dashboard, settings), which need
// their code at once.
export function useLeanResourceHints(enabled: () => boolean = () => true): void {
  if (!import.meta.server) return
  const event = useRequestEvent()
  if (event && enabled()) event.context[LEAN_RESOURCE_HINTS_FLAG] = true
}
