import type { DocTheme } from '~~/shared/types/theme'
import type { UpdateThemeInput } from './themeSchema'

// Applying an `update_theme` patch to a theme. Shared with the design
// import, which turns the vision model's proposal into a theme the same way.

/**
 * Numeric fields are declared as string enums in the Zod schema for
 * function-call schema stability: weight (headings), columns (layout),
 * maxDepth (toc). Coerce them back to numbers before deep-merge +
 * isValidTheme.
 */
export function coerceThemePatch(patch: UpdateThemeInput): Record<string, unknown> {
  const out: Record<string, unknown> = { ...patch }
  // Directives (NOT theme fields) — strip so they don't leak into
  // mergeTheme and land on the final DocTheme.
  delete out.preset
  delete out.theme_id
  delete out.from_workspace_default
  if (patch.headings?.weight !== undefined) {
    out.headings = { ...patch.headings, weight: Number(patch.headings.weight) }
  }
  if (patch.layout?.columns !== undefined) {
    out.layout = { ...patch.layout, columns: Number(patch.layout.columns) }
  }
  if (patch.toc?.maxDepth !== undefined) {
    out.toc = { ...patch.toc, maxDepth: Number(patch.toc.maxDepth) }
  }
  return out
}

/**
 * Deep-merge a partial theme patch over a complete current theme: top-level
 * sections (`body`), their fields (`body.size`) and — for object-valued
 * fields like `headings.levels` — one level further, so a patch for
 * `levels.h1` keeps `levels.h2`. The entry itself (`levels.h1`) is
 * replaced as a whole (`{}` clears it); arrays are replaced.
 */
export function mergeTheme(current: DocTheme, patch: Record<string, unknown>): DocTheme {
  const base: Record<string, unknown> = { ...current }
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainRecord(value)) {
      const section = base[key]
      merged[key] = mergeSection(isPlainRecord(section) ? section : {}, value)
    } else if (value !== undefined) {
      merged[key] = value
    }
  }
  // Untyped patch merged into a theme: both callers validate the result
  // (DocThemeSchema / isValidTheme) before it is used or stored.
  return merged as unknown as DocTheme
}

function mergeSection(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...current }
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const existing = current[field]
    out[field] = isPlainRecord(value) && isPlainRecord(existing) ? { ...existing, ...value } : value
  }
  return out
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Short human-readable summary of what the patch changed.
 */
export function summarizePatch(patch: UpdateThemeInput): string {
  const parts: string[] = []
  if (patch.preset) parts.push(`preset=${patch.preset}`)
  if (patch.theme_id) parts.push(`saved=${patch.theme_id}`)
  if (patch.from_workspace_default) parts.push('workspace-default')
  // Directive keys are tracked above; everything else is a theme-field
  // section. `from_workspace_default` is a boolean (not an object), so
  // the `typeof === 'object'` filter excludes it naturally — listed
  // here for the linter / readers.
  const DIRECTIVE_KEYS = new Set(['preset', 'theme_id', 'from_workspace_default'])
  const touched = Object.entries(patch)
    .filter(([k, v]) => !DIRECTIVE_KEYS.has(k) && v && typeof v === 'object' && Object.keys(v).length > 0)
    .map(([k]) => k)
  // customCss is a string field, so the object filter above skips it.
  if (patch.customCss !== undefined) touched.push('customCss')
  if (touched.length) parts.push(touched.join(', '))
  return parts.length ? parts.join(' + ') : '(no changes)'
}
