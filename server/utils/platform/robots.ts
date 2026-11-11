// Keep user documents out of search engines.
//
// Documents (`/d/:id`, anonymous or not), the internal print/render page
// and the document API responses (PDF download) get
// `X-Robots-Tag: noindex, nofollow`; the doc page also carries the
// matching <meta name="robots">. Landing, docs, pricing and legal pages
// stay indexable — unless the whole instance is marked not indexable
// (`NUXT_SITE_INDEXABLE=false`, staging): then every response carries
// the header and robots.txt disallows everything.
//
// robots.txt (server/routes/robots.txt.ts) deliberately does NOT
// disallow /d/: a crawler that may not fetch a document never sees its
// noindex and can still list the bare URL when it is linked elsewhere.
// Documents must stay fetchable so the header + meta take effect.

import { isNoindexPath } from '../../../shared/seo/paths'

export const NOINDEX_VALUE = 'noindex, nofollow'

/**
 * X-Robots-Tag value for a request path, or null when the page may be
 * indexed. `indexable: false` (staging) noindexes every path.
 */
export function robotsTagFor(path: string, indexable = true): string | null {
  if (!indexable) return NOINDEX_VALUE
  return isNoindexPath(path) ? NOINDEX_VALUE : null
}

export interface RobotsTxtOptions {
  /** False on staging: `Disallow: /` for every agent. */
  indexable?: boolean
  /** Absolute sitemap URL (marketing site only); omitted when null. */
  sitemapUrl?: string | null
}

/** robots.txt body. */
export function robotsTxt(options: RobotsTxtOptions = {}): string {
  if (options.indexable === false) {
    return ['User-agent: *', 'Disallow: /', ''].join('\n')
  }
  const lines = [
    'User-agent: *',
    'Disallow: /_internal/',
    'Disallow: /api/',
    'Disallow: /admin/',
    'Disallow: /settings/',
    'Disallow: /invites/',
    'Disallow: /waitlist/'
  ]
  if (options.sitemapUrl) lines.push('', `Sitemap: ${options.sitemapUrl}`)
  lines.push('')
  return lines.join('\n')
}
