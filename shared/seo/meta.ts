// Page-metadata constants shared by the title template (app/app.vue),
// useMarketingSeo and the meta-length tests.

export const SITE_NAME = 'markoto'

/** `<title>` when a page sets none (and the home page's own title). */
export const DEFAULT_TITLE = 'markoto — Collaborative Markdown'

/** Separator the title template puts between page title and site name. */
const TITLE_SUFFIX = ` · ${SITE_NAME}`

/**
 * `%s · markoto`; pages without a title get DEFAULT_TITLE. On a managed
 * private instance the customer's name follows: `%s · markoto ·
 * Kanton Musterstadt`, without a title `markoto · Kanton Musterstadt`.
 */
export function applyTitleTemplate(title: string | null | undefined, brandName = ''): string {
  if (brandName) return title ? `${title}${TITLE_SUFFIX} · ${brandName}` : `${SITE_NAME} · ${brandName}`
  return title ? `${title}${TITLE_SUFFIX}` : DEFAULT_TITLE
}

/** Search-result limits the meta-length tests enforce. */
export const MAX_TITLE_LENGTH = 60
export const MAX_DESCRIPTION_LENGTH = 160

/**
 * `robots` meta of every indexable public page: large image previews in
 * search results (the cards and flow screenshots are ours to show).
 */
export const INDEXABLE_ROBOTS = 'index, follow, max-image-preview:large'
/** `robots` meta of a public page that must not be indexed (unreviewed translations). */
export const NOINDEX_ROBOTS = 'noindex, follow'

/** `og:locale` (language_TERRITORY) for a BCP 47 tag; '' when it has no territory. */
export function ogLocale(bcp47: string): string {
  const [lang, region] = bcp47.split('-')
  if (!lang || !region) return ''
  return `${lang.toLowerCase()}_${region.toUpperCase()}`
}

/**
 * i18n key of a legal page's meta description (`legal.seoDescription.<slug>`,
 * in every UI language). Titles come from the documents.
 */
export function legalDescriptionKey(slug: string): string {
  return `legal.seoDescription.${slug}`
}
