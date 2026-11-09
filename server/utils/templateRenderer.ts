import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { getTemplate, templateLocale } from '~~/shared/templates'

/**
 * Server-side template body renderer. The body files live as plain
 * markdown under `shared/templates/content/<id>/<locale>.md`. We read
 * them at module-load time into an in-memory cache — they're tiny
 * (a few KB each) and frequently used, so paying the disk read once
 * per process beats re-reading per request.
 *
 * Why fs.readFileSync (not Vite `?raw`): Nitro's rollup pipeline
 * doesn't transform `?raw` query imports outside the Vite client
 * bundle, so the same import that works for the editor would 500
 * SSR. Pure Node fs works in both `bun run dev` and the production
 * Nitro build, with no plugin coordination.
 */

// Resolve the templates content directory from process.cwd() — the repo
// root under `bun run dev`, `/app` in the prod container. The earlier
// import.meta.url approach was fragile: once Nitro bundles this file into
// a .output chunk, `../../shared/...` no longer points at the source tree,
// so every template body 500'd/returned null in prod. The .md bodies are
// shipped to /app/shared/templates/content by the Dockerfile (fs reads
// aren't traced into the Nitro bundle, same as content/legal + drizzle).
const CONTENT_ROOT = resolve(process.cwd(), 'shared/templates/content')

const cache = new Map<string, string>()

function readBody(templateId: string, locale: string): string | null {
  const cacheKey = `${templateId}:${locale}`
  if (cache.has(cacheKey)) return cache.get(cacheKey)!
  const path = resolve(CONTENT_ROOT, templateId, `${locale}.md`)
  if (!existsSync(path)) return null
  const body = readFileSync(path, 'utf-8')
  cache.set(cacheKey, body)
  return body
}

export interface TemplateContext {
  title: string
  description: string
  /** Doc's language string — ISO code or free-text. Resolves to a locale file. */
  language: string
}

/**
 * Render the template body for a doc. Returns null if the templateId
 * is unknown (registered ids and aliases are known) OR if the template has no content (the `blank` template).
 *
 * Placeholder substitution is intentionally minimal: `{{title}}` and
 * `{{description}}` are the only supported variables. Anything more
 * (Mustache-style conditionals, loops) would warrant a real template
 * engine, which we don't need yet.
 */
export function renderTemplate(templateId: string, ctx: TemplateContext): string | null {
  // Retired ids (aliases, e.g. `academic-paper` on older documents) render
  // the template they became.
  const meta = getTemplate(templateId)
  if (!meta?.hasContent) return null

  const locale = templateLocale(ctx.language)
  const body = readBody(meta.content, locale) ?? readBody(meta.content, 'en')
  if (!body) return null

  const safeTitle = ctx.title.trim() || (locale === 'de' ? 'Unbenannt' : 'Untitled')
  return body
    .replaceAll('{{title}}', safeTitle)
    .replaceAll('{{description}}', ctx.description)
}
