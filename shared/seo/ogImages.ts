// Social preview cards (Open Graph / Twitter), one per page group. All are
// 1200×630 JPEGs committed under public/og/, built by
// scripts/build-og-image.sh from the product-tour posters — nothing is
// generated at runtime. A marketing page can override its group's card
// with frontmatter `ogImage` (+ `ogImageAlt`); it must be 1200×630 too.

import { isDocsPath, pathnameOf } from './paths'

export interface OgImage {
  /** Site-relative path. */
  path: string
  width: number
  height: number
  alt: string
}

export const OG_IMAGE_WIDTH = 1200
export const OG_IMAGE_HEIGHT = 630

export type OgImageGroup = 'default' | 'pricing' | 'useCases' | 'compare' | 'docs'

function card(path: string, alt: string): OgImage {
  return Object.freeze({ path, width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT, alt })
}

export const OG_IMAGES: Readonly<Record<OgImageGroup, OgImage>> = Object.freeze({
  default: card('/og/markoto.jpg', 'The markoto editor: Markdown on the left, the paged document preview on the right'),
  pricing: card('/og/pricing.jpg', 'markoto pricing: self-hosted, no account, free account or a paid plan'),
  useCases: card('/og/use-cases.jpg', 'markoto: Markdown documents laid out as printed pages, exported as PDF'),
  compare: card('/og/compare.jpg', 'markoto compared with other editors, with sources for every fact'),
  docs: card('/og/docs.jpg', 'markoto documentation: guides, walkthroughs and reference')
})

/**
 * The card for a route path: `/pricing`, `/docs/**`, `/compare/**` (incl.
 * `/de/compare/…`) get their group's card, every other marketing content
 * page the use-case card (`marketingPage: true`), the rest the default.
 */
export function ogImageForPath(path: string, opts: { marketingPage?: boolean } = {}): OgImage {
  const pathname = pathnameOf(path)
  if (pathname === '/pricing') return OG_IMAGES.pricing
  if (isDocsPath(pathname)) return OG_IMAGES.docs
  if (/^\/(?:(?:de|fr)\/)?compare(?:\/|$)/.test(pathname)) return OG_IMAGES.compare
  if (opts.marketingPage) return OG_IMAGES.useCases
  return OG_IMAGES.default
}
