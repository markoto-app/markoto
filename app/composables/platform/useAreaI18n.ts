import { DOCS_LOCALE, isDocsPath } from '~~/shared/docs/docsSections'

// UI texts for components that can sit inside the docs area.
//
// The docs content is English only. Until it is translated, the chrome
// around it (docs layout, sidebar, search, pager, "On this page", flow
// player, and the shared header menu + footer when they are shown on a
// docs page) is English too, whatever the UI language is. Everything
// outside /docs keeps the visitor's language: the global locale and its
// cookie are never touched, texts are only LOOKED UP in English.
//
// This file is the one place that decides it:
//   - `useAreaLocale()`: `en` on a docs route, the UI locale elsewhere.
//   - `useAreaI18n()`: a `t` that translates into that locale. Components
//     of the docs area call it instead of `useI18n()` / `$t`.
//   - `loadAreaMessages()`: the docs layout awaits it, so the English
//     texts are loaded when the UI language is another one (locale files
//     are lazy).
// app.vue feeds `useAreaLocale()` to Nuxt UI's built-in texts and to
// `<html lang>`.

type Named = Record<string, unknown>
type UiLocale = ReturnType<typeof useNuxtApp>['$i18n']['locale']['value']

export function useAreaLocale(): ComputedRef<UiLocale> {
  const route = useRoute()
  const { locale } = useNuxtApp().$i18n
  return computed(() => (isDocsPath(route.path) ? DOCS_LOCALE : locale.value))
}

export function useAreaI18n(): {
  t: (key: string, named?: Named) => string
  locale: ComputedRef<UiLocale>
} {
  const { t: globalT } = useNuxtApp().$i18n
  const locale = useAreaLocale()
  const t = (key: string, named: Named = {}): string => globalT(key, named, { locale: locale.value })
  return { t, locale }
}

/** Load the English texts when the UI language is another one. */
export async function loadAreaMessages(): Promise<void> {
  const { locale, loadLocaleMessages } = useNuxtApp().$i18n
  if (locale.value !== DOCS_LOCALE) await loadLocaleMessages(DOCS_LOCALE)
}
