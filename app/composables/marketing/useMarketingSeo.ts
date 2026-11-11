import type { ComputedRef, MaybeRefOrGetter } from 'vue'
import { INDEXABLE_ROBOTS, NOINDEX_ROBOTS, ogLocale, SITE_NAME } from '~~/shared/seo/meta'
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH, OG_IMAGES, ogImageForPath, type OgImageGroup } from '~~/shared/seo/ogImages'
import { isoDate } from '~~/shared/seo/structuredData'

export interface MarketingSeoInput {
  /** Page title without the `· markoto` suffix (the title template adds it). */
  title: MaybeRefOrGetter<string>
  /** Meta description, ≤ 160 characters. */
  description: MaybeRefOrGetter<string>
  /**
   * Card group (`shared/seo/ogImages.ts`); default: from the route path
   * (`/pricing`, `/docs/**`, `/compare/**`, else the default card).
   */
  imageGroup?: OgImageGroup
  /** Site-relative path of a 1200×630 PNG/JPEG overriding the group's card (frontmatter `ogImage`). */
  image?: string | null
  /** Alt text of `image`; default: the group card's. */
  imageAlt?: string | null
  /**
   * Use the title as-is, without the `· markoto` suffix — for the home
   * page, whose title already leads with the brand.
   */
  bareTitle?: boolean
  /** `og:type`: `article` for docs, comparisons and use-case pages; `website` otherwise. */
  type?: 'website' | 'article'
  /** Last substantive change, YYYY-MM-DD → `article:modified_time`. */
  modifiedTime?: MaybeRefOrGetter<string | null | undefined>
  /** `noindex, follow` instead of the indexable robots meta (unreviewed translations). */
  noindex?: MaybeRefOrGetter<boolean>
}

export interface MarketingSeo {
  /** Absolute URL of the page's card, or undefined without a site URL. */
  imageUrl: ComputedRef<string | undefined>
}

/**
 * Title, description, robots, Open Graph and Twitter card tags for a
 * public (indexable) page. og:url / og:image are absolute, built from
 * `NUXT_SITE_URL`; without one they are left out (relative URLs are
 * useless to unfurlers, and the Host header is never trusted). Every
 * card is 1200×630, so width/height/alt are always stated.
 */
export function useMarketingSeo(input: MarketingSeoInput): MarketingSeo {
  const { siteUrl } = useInstanceConfig()
  const route = useRoute()
  const { locale, localeProperties } = useI18n()
  const url = useCanonicalUrl()
  const title = computed(() => toValue(input.title))
  const fullTitle = computed(() => (input.bareTitle ? title.value : `${title.value} · ${SITE_NAME}`))
  const description = computed(() => toValue(input.description) || undefined)
  const card = computed(() => (input.imageGroup ? OG_IMAGES[input.imageGroup] : ogImageForPath(route.path)))
  const imagePath = computed(() => input.image || card.value.path)
  const imageAlt = computed(() => (input.image ? input.imageAlt || card.value.alt : card.value.alt))
  const imageUrl = computed(() => (siteUrl.value ? `${siteUrl.value}${imagePath.value}` : undefined))
  const isArticle = input.type === 'article'
  const modified = computed(() => (isArticle ? isoDate(toValue(input.modifiedTime)) : undefined))

  if (input.bareTitle) useHead({ titleTemplate: null })
  useSeoMeta({
    title: () => title.value,
    description: () => description.value,
    robots: () => (toValue(input.noindex) ? NOINDEX_ROBOTS : INDEXABLE_ROBOTS),
    ogTitle: () => fullTitle.value,
    ogDescription: () => description.value,
    ogType: isArticle ? 'article' : 'website',
    ogSiteName: SITE_NAME,
    ogLocale: () => ogLocale(localeProperties.value.language ?? locale.value) || undefined,
    ogUrl: () => url.value ?? undefined,
    ogImage: () => imageUrl.value,
    ogImageWidth: () => (imageUrl.value ? OG_IMAGE_WIDTH : undefined),
    ogImageHeight: () => (imageUrl.value ? OG_IMAGE_HEIGHT : undefined),
    ogImageAlt: () => (imageUrl.value ? imageAlt.value : undefined),
    ogImageType: () => (imageUrl.value ? (imagePath.value.endsWith('.png') ? 'image/png' : 'image/jpeg') : undefined),
    articleModifiedTime: () => modified.value,
    // A large card needs an (absolute) image; without a site URL there is none.
    twitterCard: () => (imageUrl.value ? 'summary_large_image' : 'summary'),
    twitterTitle: () => fullTitle.value,
    twitterDescription: () => description.value,
    twitterImage: () => imageUrl.value,
    twitterImageAlt: () => (imageUrl.value ? imageAlt.value : undefined)
  })
  return { imageUrl }
}
