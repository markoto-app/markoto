// Page-metadata constants shared by the title template (app/app.vue),
// useMarketingSeo and the meta-length tests.

export const SITE_NAME = 'markoto'

/** `<title>` when a page sets none (and the home page's own title). */
export const DEFAULT_TITLE = 'markoto — Collaborative Markdown'

/** Separator the title template puts between page title and site name. */
export const TITLE_SUFFIX = ` · ${SITE_NAME}`

/** `%s · markoto`; pages without a title get DEFAULT_TITLE. */
export function applyTitleTemplate(title: string | null | undefined): string {
  return title ? `${title}${TITLE_SUFFIX}` : DEFAULT_TITLE
}

/** Search-result limits the meta-length tests enforce. */
export const MAX_TITLE_LENGTH = 60
export const MAX_DESCRIPTION_LENGTH = 160

/**
 * Default Open Graph / Twitter card image (built by
 * scripts/build-og-image.sh from a tour poster; JPEG because some
 * unfurlers ignore WebP).
 */
export const DEFAULT_OG_IMAGE = Object.freeze({
  path: '/og/markoto.jpg',
  width: 1200,
  height: 630,
  alt: 'The markoto editor: Markdown on the left, the paged document preview on the right'
})

/** /docs landing page (app/pages/docs/index.vue). */
export const DOCS_LANDING_SEO = Object.freeze({
  title: 'Documentation',
  description: 'Guides, walkthroughs, and reference for the markoto collaborative markdown editor.'
})
