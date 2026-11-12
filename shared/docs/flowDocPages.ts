// Maps a Playwright flow slug to the docs page that embeds it.
//
// A docs page embeds a flow with `::flow{id="<slug>" ...}`. The "Try next"
// card under every flow names the next flow by slug (`flow.next({ slug })`
// in the spec), so the docs site needs to turn that slug back into the
// page a reader can open. The map is built from the markdown sources at
// build time (nuxt.config.ts → appConfig.flowDocPages) and the same
// helpers back scripts/build-flows.ts + the unit test that checks every
// spec's next slug resolves.
//
// Pure functions only: the filesystem walk lives in
// scripts/lib/flowDocPagesFs.ts so this module stays importable from the
// browser bundle.

const FLOW_EMBED_RE = /::flow\{[^}]*\bid="([^"]+)"/g

/** Every flow slug a markdown source embeds, in order of appearance. */
export function flowEmbedSlugs(markdown: string): string[] {
  return Array.from(markdown.matchAll(FLOW_EMBED_RE), m => m[1] ?? '').filter(Boolean)
}

/**
 * The /docs route for a markdown file path relative to content/docs
 * (`writing/comments.md` → `/docs/writing/comments`,
 * `writing/index.md` → `/docs/writing`).
 */
export function docsRouteForFile(relPath: string): string {
  const parts = relPath.replaceAll('\\', '/').replace(/\.md$/, '').split('/').filter(Boolean)
  if (parts.at(-1) === 'index') parts.pop()
  return ['/docs', ...parts].join('/')
}

/**
 * Build the slug → route map from (relative path, markdown) pairs. When two
 * pages embed the same flow, the first one (sorted by path) wins so the map
 * is deterministic.
 */
export function buildFlowDocPages(files: Array<{ path: string, text: string }>): Record<string, string> {
  const map: Record<string, string> = {}
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path))
  for (const file of sorted) {
    if (!file.path.endsWith('.md')) continue
    for (const slug of flowEmbedSlugs(file.text)) {
      map[slug] ??= docsRouteForFile(file.path)
    }
  }
  return map
}

/** Docs route for `slug`, or null when no docs page embeds that flow. */
export function resolveFlowDocPage(map: unknown, slug: string): string | null {
  if (typeof map !== 'object' || map === null) return null
  const route = (map as Record<string, unknown>)[slug]
  return typeof route === 'string' && route.startsWith('/docs') ? route : null
}
