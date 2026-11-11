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

/** /docs landing page (app/pages/docs/index.vue). */
export const DOCS_LANDING_SEO = Object.freeze({
  title: 'Documentation',
  description: 'Guides, walkthroughs, and reference for the markoto collaborative markdown editor.'
})

/**
 * Meta descriptions of the legal pages (English: the authoritative
 * language and the one crawlers get). Titles come from the documents.
 */
export const LEGAL_PAGE_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  'privacy': 'How markoto handles personal data: what is processed, why, for how long, by which sub-processors, and your rights under the GDPR and Swiss law.',
  'terms': 'The terms of use for markoto: accounts, documents without an account, acceptable use, AI features, liability and how the terms change.',
  'paid-terms': 'The terms for Pro, Team and Business plans and AI credits: seats, renewal and cancellation, credits, refunds and your right of withdrawal.',
  'dpa': 'The data processing addendum for workspace owners: markoto processes workspace content on your behalf under GDPR Article 28.',
  'abuse-policy': 'What is not allowed on markoto, how to report illegal content or abuse, and how reports are handled and decided.',
  'imprint': 'Legal notice for markoto: the operating company, its address and how to contact it.',
  'sub-processors': 'Every company that processes data for markoto: what it does, where the data is stored and how transfers are covered.'
})
