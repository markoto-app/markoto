import type { MaybeRefOrGetter } from 'vue'
import { DEFAULT_OG_IMAGE, SITE_NAME } from '~~/shared/seo/meta'

export interface MarketingSeoInput {
  /** Page title without the `· markoto` suffix (the title template adds it). */
  title: MaybeRefOrGetter<string>
  /** Meta description, ≤ 160 characters. */
  description: MaybeRefOrGetter<string>
  /** Site-relative path of a 1200×630 PNG/JPEG; default: the markoto card. */
  image?: string
  /**
   * Use the title as-is, without the `· markoto` suffix — for the home
   * page, whose title already leads with the brand.
   */
  bareTitle?: boolean
}

/**
 * Title, description, Open Graph and Twitter card tags for a public
 * (indexable) page. og:url / og:image are absolute, built from
 * `NUXT_SITE_URL`; without one they are left out (relative URLs are
 * useless to unfurlers, and the Host header is never trusted).
 */
export function useMarketingSeo(input: MarketingSeoInput): void {
  const { siteUrl } = useInstanceConfig()
  const url = useCanonicalUrl()
  const title = computed(() => toValue(input.title))
  const fullTitle = computed(() => (input.bareTitle ? title.value : `${title.value} · ${SITE_NAME}`))
  const image = computed(() => (siteUrl.value ? `${siteUrl.value}${input.image ?? DEFAULT_OG_IMAGE.path}` : undefined))
  const isDefaultImage = input.image === undefined

  if (input.bareTitle) useHead({ titleTemplate: null })
  useSeoMeta({
    title: () => title.value,
    description: () => toValue(input.description) || undefined,
    ogTitle: () => fullTitle.value,
    ogDescription: () => toValue(input.description) || undefined,
    ogType: 'website',
    ogSiteName: SITE_NAME,
    ogUrl: () => url.value ?? undefined,
    ogImage: () => image.value,
    ogImageWidth: () => (image.value && isDefaultImage ? DEFAULT_OG_IMAGE.width : undefined),
    ogImageHeight: () => (image.value && isDefaultImage ? DEFAULT_OG_IMAGE.height : undefined),
    ogImageAlt: () => (image.value && isDefaultImage ? DEFAULT_OG_IMAGE.alt : undefined),
    twitterCard: () => (image.value ? 'summary_large_image' : 'summary'),
    twitterTitle: () => fullTitle.value,
    twitterDescription: () => toValue(input.description) || undefined,
    twitterImage: () => image.value
  })
}
