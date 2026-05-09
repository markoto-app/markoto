import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { getTemplate, TEMPLATE_LOCALES, type TemplateLocale } from '~~/shared/templates'

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

// Resolve the templates content directory once. `import.meta.url` is
// the file URL of THIS file, which can be either source-tree or
// bundled — both shapes resolve `../../shared/...` correctly.
const HERE = dirname(fileURLToPath(import.meta.url))
const CONTENT_ROOT = resolve(HERE, '../..', 'shared/templates/content')

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

/**
 * Resolve the doc's language string to a template locale. ISO codes
 * match directly; BCP-47 region tags are stripped (`de-CH` → `de`);
 * free-text values fall back to English.
 */
function resolveTemplateLocale(language: string): string {
  const list = TEMPLATE_LOCALES as readonly string[]
  if (list.includes(language)) return language
  const base = language.split('-')[0]?.toLowerCase()
  if (base && list.includes(base)) return base
  return 'en'
}

export interface TemplateContext {
  title: string
  description: string
  /** Doc's language string — ISO code or free-text. Resolves to a locale file. */
  language: string
}

/**
 * Render the template body for a doc. Returns null if the templateId
 * is unknown OR if the template has no content (the `blank` template).
 *
 * Placeholder substitution is intentionally minimal: `{{title}}` and
 * `{{description}}` are the only supported variables. Anything more
 * (Mustache-style conditionals, loops) would warrant a real template
 * engine, which we don't need yet.
 */
export function renderTemplate(templateId: string, ctx: TemplateContext): string | null {
  const meta = getTemplate(templateId)
  if (!meta?.hasContent) return null

  const locale = resolveTemplateLocale(ctx.language) as TemplateLocale
  const body = readBody(templateId, locale) ?? readBody(templateId, 'en')
  if (!body) return null

  const safeTitle = ctx.title.trim() || (locale === 'de' ? 'Unbenannt' : 'Untitled')
  return body
    .replaceAll('{{title}}', safeTitle)
    .replaceAll('{{description}}', ctx.description)
}
