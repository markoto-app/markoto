import type { DocTheme } from '~~/shared/types/theme'
import { DocThemeSchema } from '~~/shared/types/theme'
import { defaultTheme } from '~~/shared/utils/theme/defaultTheme'
import { isAudienceKind } from '~~/shared/audiences'
import { resolveTemplateId } from '~~/shared/templates'
import { LANGUAGE_MAX_LENGTH } from '~~/shared/languages'
import { DOC_DESCRIPTION_MAX_LENGTH, DOC_TITLE_MAX_LENGTH } from '~~/shared/config/docCreate'
import { isBoundedJsonValue, META_THEME_MAX_DEPTH, META_THEME_MAX_NODES } from '~~/shared/utils/documents/ymetaValidation'
import { adaptCustomCssToDoc, sanitizeCustomCss } from '~~/shared/utils/theme/customCss'
import { themeImagesForDoc } from '~~/shared/utils/theme/themeImages'
import { splitMarkotoFrontmatter, type ImportedDocProperties } from '~~/shared/utils/markdown/markdownFrontmatter'

/**
 * Server side of the Markdown import (`POST /api/import` with a `.md`
 * file): strips markoto's own frontmatter (`shared/utils/markdown/markdownFrontmatter.ts`)
 * and turns it into document properties the editor can apply.
 *
 * The frontmatter is untrusted (anyone can write a `.md` file). Every
 * field goes through the same checks as `PUT /api/docs/:id/meta`:
 *   - title ≤ 255, description ≤ 500, language 1–50, audience enum,
 *     templateId from the template registry;
 *   - theme: bounded JSON first, then filled up with defaults for fields
 *     an older markoto didn't have, then the strict `DocThemeSchema`;
 *     images that aren't this document's uploads are cleared;
 *   - custom CSS: every rule the sanitizer refuses for THIS document
 *     (typically `url()` to another document's uploads; also anything
 *     not allowed at all) is dropped (`adaptCustomCssToDoc`), then the
 *     rest must re-check with no issue, else the custom CSS is left out.
 * A field that fails is left out (listed in `ignored`); unknown keys are
 * ignored silently. Nothing is written here: the editor applies the
 * result through its normal setters, which the sync server and
 * `PUT /meta` validate again.
 */

export interface MarkdownImportResult {
  markdown: string
  /** Present when the file carried markoto frontmatter. */
  properties?: ImportedDocProperties
  /** Frontmatter fields that were present but failed validation. */
  ignored?: string[]
  /** Custom CSS problems removed on import (rules using another document's images, disallowed rules). */
  droppedCustomCssRules?: number
}

export function importMarkdownFile(
  text: string,
  opts: { docId: string, allowedOrigins: readonly string[] }
): MarkdownImportResult {
  const split = splitMarkotoFrontmatter(text)
  if (split.kind !== 'markoto') return { markdown: text }

  const { data } = split
  const properties: ImportedDocProperties = {}
  const ignored: string[] = []

  const title = readString(data.title, DOC_TITLE_MAX_LENGTH, false)
  if (title !== undefined) properties.title = title
  else if ('title' in data) ignored.push('title')

  const description = readString(data.description, DOC_DESCRIPTION_MAX_LENGTH, true)
  if (description !== undefined) properties.description = description
  else if ('description' in data) ignored.push('description')

  if (isAudienceKind(data.audience)) properties.audience = data.audience
  else if ('audience' in data) ignored.push('audience')

  const language = readString(data.language, LANGUAGE_MAX_LENGTH, false)
  if (language !== undefined) properties.language = language
  else if ('language' in data) ignored.push('language')

  const templateId = resolveTemplateId(data.templateId)
  if (templateId !== null) properties.templateId = templateId
  else if ('templateId' in data) ignored.push('templateId')

  let droppedCustomCssRules = 0
  if ('theme' in data) {
    const theme = readTheme(data.theme, opts)
    if (theme) {
      properties.theme = theme.theme
      droppedCustomCssRules = theme.droppedCustomCssRules
      if (theme.customCssRemoved) ignored.push('theme.customCss')
    } else {
      ignored.push('theme')
    }
  }

  const result: MarkdownImportResult = { markdown: split.body, properties }
  if (ignored.length > 0) result.ignored = ignored
  if (droppedCustomCssRules > 0) result.droppedCustomCssRules = droppedCustomCssRules
  return result
}

/** Trimmed string within `max`; empty allowed only when `allowEmpty`. */
function readString(raw: unknown, max: number, allowEmpty: boolean): string | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  if (value.length > max) return undefined
  if (!allowEmpty && value.length === 0) return undefined
  return value
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/**
 * `defaults` with `raw` laid over it, one level of objects at a time.
 * Keys only `raw` has are kept (the strict schema rejects the unknown
 * ones; optional fields such as `customCss` pass). Arrays and scalars
 * from `raw` replace the default.
 */
function overDefaults(defaults: Record<string, unknown>, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...defaults }
  for (const [key, value] of Object.entries(raw)) {
    const base = defaults[key]
    out[key] = isPlainObject(base) && isPlainObject(value) ? overDefaults(base, value) : value
  }
  return out
}

function readTheme(
  raw: unknown,
  opts: { docId: string, allowedOrigins: readonly string[] }
): { theme: DocTheme, droppedCustomCssRules: number, customCssRemoved: boolean } | null {
  if (!isPlainObject(raw)) return null
  if (!isBoundedJsonValue(raw, { maxDepth: META_THEME_MAX_DEPTH, maxNodes: META_THEME_MAX_NODES })) return null
  const parsed = DocThemeSchema.safeParse(overDefaults(structuredClone(defaultTheme), raw))
  if (!parsed.success) return null

  // Images (logo, header/footer image) must be this document's uploads.
  let theme = themeImagesForDoc(parsed.data, opts.docId).theme
  let droppedCustomCssRules = 0
  let customCssRemoved = false
  if (theme.customCss !== undefined && theme.customCss.trim() !== '') {
    const sanitizeOpts = { docId: opts.docId, allowedOrigins: opts.allowedOrigins }
    const adapted = adaptCustomCssToDoc(theme.customCss, sanitizeOpts)
    droppedCustomCssRules = adapted.dropped.length
    const css = adapted.css ?? ''
    // What remains must be clean exactly as the write path demands.
    if (css.trim() !== '' && sanitizeCustomCss(css, sanitizeOpts).issues.length > 0) {
      theme = { ...theme }
      delete theme.customCss
      customCssRemoved = true
    } else {
      theme = { ...theme, customCss: css }
    }
  }
  return { theme, droppedCustomCssRules, customCssRemoved }
}
