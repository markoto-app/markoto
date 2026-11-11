import { parseDocument, stringify } from 'yaml'
import type { DocTheme } from '../types/theme'

/**
 * YAML frontmatter that "Download Markdown" writes on top of the file and
 * the Markdown import reads back, so a document's theme and properties
 * survive the round trip:
 *
 *   ---
 *   markoto: 1
 *   title: Q3 report
 *   description: …
 *   audience: business
 *   language: en
 *   templateId: blank
 *   theme:
 *     page: { … }
 *     …
 *     customCss: |
 *       .paged-doc h2 { … }
 *   ---
 *
 *   # Q3 report
 *   …
 *
 * This module only splits and parses (and builds on export). It never
 * decides what is valid: the server import (`server/utils/documents/markdownImport.ts`)
 * runs every field through the same validators as `PUT /api/docs/:id/meta`
 * (theme schema, custom-CSS sanitizer, image rules, length limits, enums).
 *
 * Frontmatter is recognised as markoto's ONLY when it parses as a YAML
 * mapping whose `markoto` key is a version this build understands
 * (`MARKOTO_FRONTMATTER_VERSION`). Anything else at the top of a file
 * (Jekyll / Hugo / Obsidian frontmatter, a newer markoto version, broken
 * YAML) is left in the body untouched: it is the writer's text and the
 * import has no business deleting it.
 */

export const MARKOTO_FRONTMATTER_VERSION = 1

/** Larger frontmatter blocks are not read at all (a theme with 64 KB of custom CSS is ~70 KB). */
export const FRONTMATTER_MAX_BYTES = 256 * 1024

export interface MarkdownExportProperties {
  title: string
  description: string
  audience: string
  language: string
  templateId?: string
  theme: DocTheme
}

/** Markdown file text with markoto frontmatter on top of `body`. */
export function buildMarkdownExport(body: string, props: MarkdownExportProperties): string {
  const data: Record<string, unknown> = {
    markoto: MARKOTO_FRONTMATTER_VERSION,
    title: props.title,
    description: props.description,
    audience: props.audience,
    language: props.language
  }
  if (props.templateId) data.templateId = props.templateId
  data.theme = props.theme
  // `lineWidth: 0` keeps long strings on one line; multi-line strings
  // (custom CSS) become literal block scalars.
  const yaml = stringify(data, { lineWidth: 0, aliasDuplicateObjects: false })
  return `---\n${yaml}---\n\n${body}`
}

/** Document properties read back from an import, after server-side validation. */
export interface ImportedDocProperties {
  title?: string
  description?: string
  audience?: string
  language?: string
  templateId?: string
  theme?: DocTheme
}

export type FrontmatterSplit
  = | { kind: 'none' }
    | { kind: 'foreign' }
    | { kind: 'markoto', body: string, data: Record<string, unknown> }

const OPEN = /^\uFEFF?---[ \t]*\r?\n/
const CLOSE = /^(?:---|\.\.\.)[ \t]*$/

/**
 * Find and parse a frontmatter block at the very start of `text`.
 * `none` = no frontmatter, `foreign` = frontmatter that isn't markoto's
 * (leave the text as it is), `markoto` = parsed data + the body without
 * the block (and without the blank line the export puts after it).
 */
export function splitMarkotoFrontmatter(text: string): FrontmatterSplit {
  const open = OPEN.exec(text)
  if (!open) return { kind: 'none' }
  let pos = open[0].length
  let close = -1
  let after = -1
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos)
    const lineEnd = nl === -1 ? text.length : nl
    const line = text.slice(pos, lineEnd).replace(/\r$/, '')
    if (CLOSE.test(line)) {
      close = pos
      after = nl === -1 ? text.length : nl + 1
      break
    }
    if (nl === -1) break
    pos = nl + 1
    if (pos - open[0].length > FRONTMATTER_MAX_BYTES) return { kind: 'foreign' }
  }
  if (close === -1) return { kind: 'none' }
  const yamlText = text.slice(open[0].length, close)
  if (yamlText.length > FRONTMATTER_MAX_BYTES) return { kind: 'foreign' }

  const data = parseYamlMapping(yamlText)
  if (!data || data.markoto !== MARKOTO_FRONTMATTER_VERSION) return { kind: 'foreign' }
  const body = text.slice(after).replace(/^\r?\n/, '')
  return { kind: 'markoto', body, data }
}

/**
 * Parse untrusted YAML into a plain mapping, or null. Core schema only
 * (no custom tags, no `<<` merge keys), aliases refused outright (no
 * "billion laughs"), duplicate keys are an error.
 */
function parseYamlMapping(yamlText: string): Record<string, unknown> | null {
  try {
    const doc = parseDocument(yamlText, {
      schema: 'core',
      merge: false,
      uniqueKeys: true,
      prettyErrors: false,
      strict: true
    })
    // Warnings include unknown tags (`!!js/function`): not dangerous with
    // this library, but nothing markoto writes, so not ours.
    if (doc.errors.length > 0 || doc.warnings.length > 0) return null
    const value: unknown = doc.toJS({ maxAliasCount: 0 })
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    return value as Record<string, unknown>
  } catch {
    return null
  }
}
