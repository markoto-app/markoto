import { trimTrailing } from '~/utils/markdown/trimTrailing'
import { pageStructuredData, serializeJsonLd, type PageGraphInput } from '~~/shared/seo/structuredData'

/** What a page passes: everything but the instance-wide fields. */
export type PageStructuredData = Omit<PageGraphInput, 'siteUrl' | 'operatorName' | 'inLanguage' | 'path'> & {
  /** Default: the current route path. */
  path?: string
}

/**
 * One JSON-LD `@graph` for a public page below `/` (WebPage + its
 * BreadcrumbList + the page's main entity, `shared/seo/structuredData.ts`).
 * Marketing site only, like the home page's: on a self-hosted instance
 * markoto isn't the operator's product, and its docs point their
 * canonical at markoto.app anyway. `build` returning null = none.
 *
 * CSP: a `type="application/ld+json"` block is data, never executed, so
 * `script-src` doesn't apply; `serializeJsonLd` escapes `<`.
 */
export function usePageStructuredData(build: () => PageStructuredData | null): void {
  const route = useRoute()
  const { locale, localeProperties } = useI18n()
  const { marketingSite, siteUrl, operatorName } = useInstanceConfig()
  useHead(() => {
    if (!marketingSite.value || !siteUrl.value) return {}
    const input = build()
    if (!input) return {}
    const json = serializeJsonLd(pageStructuredData({
      ...input,
      // Same path as the canonical: no trailing slash.
      path: input.path ?? (trimTrailing(route.path, '/') || '/'),
      siteUrl: siteUrl.value,
      operatorName: operatorName.value,
      inLanguage: localeProperties.value.language ?? locale.value
    }))
    return { script: [{ key: 'ld-page', type: 'application/ld+json', innerHTML: json }] }
  })
}
