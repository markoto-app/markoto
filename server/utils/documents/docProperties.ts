import type * as Y from 'yjs'
import type { DocTheme } from '~~/shared/types/theme'
import type { AudienceKind } from '~~/shared/audiences'
import { isAudienceKind } from '~~/shared/audiences'
import { isValidTheme } from '~~/shared/utils/theme/themeValidation'
import { isValidMetaValue } from '~~/shared/utils/documents/ymetaValidation'

/**
 * A document's live properties (theme + title / description / audience /
 * language / template), read the way the editor reads them: the Y.js
 * `meta` map first, the `documents` row as the fallback.
 *
 * Why ymeta wins: the editor writes every property change to ymeta
 * (broadcast to all collaborators, persisted by y-postgresql), but only
 * the OWNER's client also persists it to the row via `PUT /meta`.
 * Ownerless (anonymous) docs and changes made by workspace editors or
 * open-edit visitors therefore exist only in ymeta — the row keeps its
 * creation-time values (theme NULL for an anonymous doc). Every
 * server-side reader that must show what the editor shows (the render
 * bootstrap → server PDF, the Markdown export tool) goes through here.
 *
 * Values are re-checked with the sync server's ymeta rules
 * (`isValidMetaValue`); an invalid ymeta entry falls back to the row.
 */

export interface DocPropertiesRow {
  title: string
  description: string
  audience: AudienceKind
  language: string
  templateId: string
  theme: DocTheme | null
}

export interface DocProperties {
  title: string
  description: string
  audience: AudienceKind
  language: string
  templateId: string
  /** `null` = no theme set anywhere (render with the default theme). */
  theme: DocTheme | null
}

function metaString(ymeta: Y.Map<unknown>, key: 'title' | 'description' | 'language' | 'templateId'): string | undefined {
  const value = ymeta.get(key)
  return typeof value === 'string' && isValidMetaValue(key, value) ? value : undefined
}

export function resolveDocProperties(ymeta: Y.Map<unknown>, row: DocPropertiesRow): DocProperties {
  const ymetaTheme = ymeta.get('theme')
  const ymetaAudience = ymeta.get('audience')
  let theme: DocTheme | null = null
  if (isValidTheme(ymetaTheme) && isValidMetaValue('theme', ymetaTheme)) theme = ymetaTheme
  else if (row.theme && isValidTheme(row.theme)) theme = row.theme
  return {
    // Empty title / language in ymeta = not set (the editor falls back
    // the same way); an empty description is a real value (cleared).
    title: metaString(ymeta, 'title') || row.title,
    description: metaString(ymeta, 'description') ?? row.description,
    audience: isAudienceKind(ymetaAudience) ? ymetaAudience : row.audience,
    language: metaString(ymeta, 'language') || row.language,
    templateId: metaString(ymeta, 'templateId') || row.templateId,
    theme
  }
}
