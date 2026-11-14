import { homeStructuredData, serializeJsonLd } from '~~/shared/seo/structuredData'

/**
 * JSON-LD on the hosted home page (marketing site only, on a self-hosted
 * instance markoto isn't "the" product of the operator). Server-rendered
 * into <head>. CSP: a `type="application/ld+json"` block is data, not
 * script: browsers never execute it, so `script-src` doesn't apply; the
 * nonce plugin (`server/plugins/csp.ts`) stamps a nonce on it like on
 * every head script, which is harmless.
 */
export function useHomeStructuredData(): void {
  const { t, locale, localeProperties } = useI18n()
  const { marketingSite, siteUrl, operatorName } = useInstanceConfig()
  useHead(() => {
    if (!marketingSite.value || !siteUrl.value) return {}
    const json = serializeJsonLd(homeStructuredData({
      siteUrl: siteUrl.value,
      operatorName: operatorName.value,
      description: t('landing.subtitle'),
      inLanguage: localeProperties.value.language ?? locale.value
    }))
    return { script: [{ key: 'ld-home', type: 'application/ld+json', innerHTML: json }] }
  })
}
