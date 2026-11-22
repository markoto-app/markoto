import { LANGUAGE_PRESETS } from '../../languages'

/** UI locales (the same six as the language presets). */
export type AppLocale = typeof LANGUAGE_PRESETS[number]

/** `locale` when it is one of the UI locales, else null. */
export function asAppLocale(locale: string | null | undefined): AppLocale | null {
  const code = (locale ?? '').toLowerCase().split(/[-_]/)[0]
  return LANGUAGE_PRESETS.find(l => l === code) ?? null
}

/**
 * Words of the default title of a duplicate, per UI locale. The editor shows
 * the same strings through i18n (`duplicate.copyOf`, `editor.untitled`);
 * the server needs its own copy for a duplicate made without a title (the
 * explorer, the AI, MCP). `tests/unit/duplicateTitle.test.ts` keeps both in step.
 */
export const DUPLICATE_TITLE_WORDS: Record<AppLocale, { copyOf: string, untitled: string }> = {
  en: { copyOf: 'Copy of {title}', untitled: 'Untitled' },
  de: { copyOf: 'Kopie von {title}', untitled: 'Unbenannt' },
  fr: { copyOf: 'Copie de {title}', untitled: 'Sans titre' },
  es: { copyOf: 'Copia de {title}', untitled: 'Sin título' },
  ja: { copyOf: '{title} のコピー', untitled: '無題' },
  zh: { copyOf: '{title} 的副本', untitled: '无标题' }
}

/** "Copy of X" in `locale` (English when unknown), at most 255 characters. */
export function duplicateTitle(sourceTitle: string | null | undefined, locale: string | null | undefined): string {
  const words = DUPLICATE_TITLE_WORDS[asAppLocale(locale) ?? 'en']
  const base = sourceTitle?.trim() || words.untitled
  const title = words.copyOf.replace('{title}', base)
  return title.length > 255 ? title.slice(0, 255) : title
}
