export interface LocaleOption {
  code: string
  name?: string
}

/**
 * Name of a UI language in that language ("Deutsch"), from the configured
 * locale list. A regional code ("de-CH") matches its base language; a code
 * outside the list is returned as it is.
 */
export function localeDisplayName(code: string, locales: readonly LocaleOption[]): string {
  const base = code.split('-')[0]?.toLowerCase()
  const match = locales.find(l => l.code === code) ?? locales.find(l => l.code === base)
  return match?.name ?? code
}

/**
 * The language to show for an account: the stored one when it is a
 * configured UI language, else the language the UI is in right now (an
 * account that never chose one has no stored value).
 */
export function accountLanguageName(stored: string | null | undefined, active: string, locales: readonly LocaleOption[]): string {
  return localeDisplayName(stored?.trim() || active, locales)
}
