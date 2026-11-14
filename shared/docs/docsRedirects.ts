// Old /docs addresses and where they live now.
//
// The user docs were regrouped into task-based sections (November 2026).
// Every address that existed before answers with a permanent redirect to
// its new place: nuxt.config.ts turns this map into Nitro route rules
// (301, the query string is carried over; a `#hash` never reaches the
// server and the browser re-applies it to the new address), and the docs
// catch-all page uses it for in-app navigation to an old address.
//
// Rules, pinned by tests/unit/seo/docsRedirects.test.ts:
//   - every old address that is no longer a page has an entry,
//   - every target is an existing page (no chains),
//   - no entry shadows an existing page.
// When a page moves again: add the old address here and point the
// existing entries at the final address.

import { trimTrailingSlashes } from '../utils/trimTrailingSlashes'

export const DOCS_REDIRECTS: Readonly<Record<string, string>> = Object.freeze({
  // AI assistant
  '/docs/writing/ai-overview': '/docs/ai/overview',
  '/docs/writing/ai-prompt-bar': '/docs/ai/prompt-bar',
  '/docs/writing/ai-rewrite-selection': '/docs/ai/rewrite-selection',
  '/docs/writing/ai-comments': '/docs/ai/comments',
  '/docs/writing/document-context': '/docs/ai/document-context',
  '/docs/writing/ai-web-search': '/docs/ai/web-search',
  '/docs/writing/ai-fetch-url': '/docs/ai/fetch-url',
  '/docs/writing/ai-cross-doc': '/docs/ai/cross-doc',
  '/docs/writing/knowledge-rag': '/docs/ai/knowledge-rag',
  '/docs/writing/ai-generate-image': '/docs/ai/generate-image',
  '/docs/account/ai-provider': '/docs/ai/provider',
  '/docs/account/mcp': '/docs/ai/mcp',
  // Collaborate
  '/docs/workspaces/live-collab': '/docs/collaborate/live-collab',
  '/docs/writing/comments': '/docs/collaborate/comments',
  '/docs/writing/comment-replay': '/docs/collaborate/comment-replay',
  // Write
  '/docs/account/delete-document': '/docs/writing/delete-document',
  // Import, export and history
  '/docs/history': '/docs/import-export',
  '/docs/history/see-changes': '/docs/import-export/see-changes',
  '/docs/history/restore': '/docs/import-export/restore',
  // Workspaces
  '/docs/account/guests': '/docs/workspaces/guests',
  // Workspace administration
  '/docs/account/brand-kit': '/docs/workspace-admin/brand-kit',
  '/docs/account/single-sign-on': '/docs/workspace-admin/single-sign-on',
  '/docs/account/audit-log': '/docs/workspace-admin/audit-log',
  // Plans and billing
  '/docs/account/plans': '/docs/plans/plans',
  '/docs/account/upgrade': '/docs/plans/upgrade',
  '/docs/account/team-plan': '/docs/plans/team-plan',
  '/docs/writing/ai-budget': '/docs/plans/ai-budget',
  // Run markoto yourself
  '/docs/getting-started/self-hosting': '/docs/self-hosting'
})

/** The new address of an old docs path, or null when `path` never moved. */
export function docsRedirectTarget(path: string): string | null {
  const pathname = trimTrailingSlashes(path.split(/[?#]/)[0] ?? '')
  return Object.hasOwn(DOCS_REDIRECTS, pathname) ? DOCS_REDIRECTS[pathname] ?? null : null
}

/** Nitro route rules: one permanent redirect per old address. */
export function docsRedirectRouteRules(): Record<string, { redirect: { to: string, statusCode: 301 } }> {
  return Object.fromEntries(
    Object.entries(DOCS_REDIRECTS).map(([from, to]) => [from, { redirect: { to, statusCode: 301 as const } }])
  )
}
