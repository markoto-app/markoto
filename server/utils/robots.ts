// Keep user documents out of search engines.
//
// Documents (`/d/:id`, anonymous or not), the internal print/render page
// and the document API responses (PDF download) get
// `X-Robots-Tag: noindex, nofollow`; the doc page also carries the
// matching <meta name="robots">. Landing, docs, pricing and legal pages
// stay indexable.
//
// robots.txt (server/routes/robots.txt.ts) deliberately does NOT
// disallow /d/: a crawler that may not fetch a document never sees its
// noindex and can still list the bare URL when it is linked elsewhere.
// Documents must stay fetchable so the header + meta take effect.

export const NOINDEX_VALUE = 'noindex, nofollow'

const NOINDEX_PREFIXES = ['/d/', '/_internal/', '/api/docs/'] as const

/** X-Robots-Tag value for a request path, or null when the page may be indexed. */
export function robotsTagFor(path: string): string | null {
  const pathname = path.split('?')[0] ?? path
  if (pathname === '/d') return NOINDEX_VALUE
  return NOINDEX_PREFIXES.some(p => pathname.startsWith(p)) ? NOINDEX_VALUE : null
}

/** robots.txt body. */
export function robotsTxt(): string {
  return [
    'User-agent: *',
    'Disallow: /_internal/',
    'Disallow: /api/',
    'Disallow: /admin/',
    'Disallow: /settings/',
    'Disallow: /invites/',
    'Disallow: /waitlist/',
    ''
  ].join('\n')
}
