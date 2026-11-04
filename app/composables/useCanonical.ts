import { canonicalUrl } from '~~/shared/seo/paths'

/**
 * The current route's canonical URL (`shared/seo/paths.ts#canonicalUrl`):
 * `NUXT_SITE_URL` + path, no query string; `/docs/**` on instances other
 * than markoto.app point at markoto.app's copy. Null when none applies
 * (site URL unset, documents). Never built from the request Host.
 */
export function useCanonicalUrl() {
  const route = useRoute()
  const { siteUrl, docsCanonicalBase } = useInstanceConfig()
  return computed(() => canonicalUrl(route.path, {
    siteUrl: siteUrl.value,
    docsCanonicalBase: docsCanonicalBase.value
  }))
}

/** Emits `<link rel="canonical">` for the current route (called once, in app.vue). */
export function useCanonical(): void {
  const url = useCanonicalUrl()
  useHead(() => ({
    link: url.value ? [{ key: 'canonical', rel: 'canonical', href: url.value }] : []
  }))
}
