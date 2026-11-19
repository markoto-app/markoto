import type { MaybeRefOrGetter } from 'vue'
import {
  localisedPath,
  MARKETING_LOCALES,
  splitMarketingLocale,
  uiPageVariants,
  variantAlternates,
  type MarketingLocale,
  type MarketingUiPage,
  type MarketingVariant
} from '~~/shared/seo/marketing'

// Language versions of the public marketing pages (shared/seo/marketing.ts):
// the page declares its versions, this sets hreflang and shares them with
// the language switcher + the language suggestion (same render, any
// component) through state keyed by the route path.

type UiLocale = ReturnType<typeof useNuxtApp>['$i18n']['locale']['value']

/** The UI language in force before the first marketing page (plugins/marketing-locale.ts). */
export function useMarketingLocaleBefore() {
  return useState<UiLocale | null>('marketing-locale-before', () => null)
}

function useVariantState() {
  return useState<{ path: string, variants: MarketingVariant[] } | null>('marketing-variants', () => null)
}

export interface MarketingLanguages {
  /** The language of the page's URL. */
  locale: ComputedRef<MarketingLocale>
  /** Whether this version may be indexed (reviewed). */
  indexable: ComputedRef<boolean>
  /** An unreviewed language version: `noindex` (useMarketingSeo). False for a page without versions. */
  noindex: ComputedRef<boolean>
}

/**
 * Called by a marketing page with its language versions: emits the
 * hreflang alternates (reviewed versions only, none on an unreviewed one)
 * and publishes the versions for the switcher. The page passes
 * `!indexable` to useMarketingSeo's `noindex`.
 */
export function useMarketingLanguages(variants: MaybeRefOrGetter<MarketingVariant[]>): MarketingLanguages {
  const route = useRoute()
  const { siteUrl } = useInstanceConfig()
  const state = useVariantState()
  const path = route.path
  const locale = computed(() => splitMarketingLocale(path).locale)
  const list = computed(() => toValue(variants))
  const indexable = computed(() => list.value.some(v => v.locale === locale.value && v.indexable))
  watchEffect(() => {
    state.value = { path, variants: list.value }
  })
  useHead(() => ({
    link: siteUrl.value
      ? variantAlternates(list.value, locale.value).map(a => ({
          key: `hreflang-${a.hreflang}`,
          rel: 'alternate',
          hreflang: a.hreflang,
          href: `${siteUrl.value}${a.path}`
        }))
      : []
  }))
  const noindex = computed(() => list.value.length > 0 && !indexable.value)
  return { locale, indexable, noindex }
}

/**
 * useMarketingLanguages for a UI page (`/`, `/pricing`, `/demo`): every UI
 * language, on the marketing site only (elsewhere there are no prefixed
 * URLs). `when`: false while the route shows something else (the
 * dashboard on `/`).
 */
export function useUiPageLanguages(page: MarketingUiPage, when: () => boolean = () => true): MarketingLanguages {
  const { marketingSite } = useInstanceConfig()
  return useMarketingLanguages(() => (marketingSite.value && when() ? uiPageVariants(page) : []))
}

/** The language versions of the current route's marketing page, or [] elsewhere. */
export function useCurrentMarketingVariants(): ComputedRef<MarketingVariant[]> {
  const route = useRoute()
  const state = useVariantState()
  return computed(() => (state.value && state.value.path === route.path ? state.value.variants : []))
}

/**
 * Links to the UI pages (`/`, `/pricing`, `/demo`) in the current UI
 * language: on a marketing page that is the page's own language, in the
 * app the visitor's, on the docs English. Unchanged off the marketing site, which has no
 * prefixed URLs.
 */
export function useMarketingPath(): (path: '/' | '/pricing' | '/demo') => string {
  const { marketingSite } = useInstanceConfig()
  // English on the docs pages, like their texts (useAreaI18n).
  const locale = useAreaLocale()
  return (path) => {
    if (!marketingSite.value) return path
    const current = MARKETING_LOCALES.find(l => l === locale.value) ?? 'en'
    return localisedPath(current, path)
  }
}

/**
 * Switch a marketing page to another language: an explicit choice, so it
 * becomes the visitor's UI language for the app too (the locale cookie),
 * then opens that language's URL.
 */
export function useChooseMarketingLanguage(): (variant: MarketingVariant) => Promise<void> {
  const i18n = useNuxtApp().$i18n
  const before = useMarketingLocaleBefore()
  return async (variant) => {
    const code = i18n.locales.value.find(l => l.code === variant.locale)?.code
    if (code) {
      i18n.setLocaleCookie(code)
      if (before.value !== null) before.value = code
    }
    await navigateTo(variant.path)
  }
}
