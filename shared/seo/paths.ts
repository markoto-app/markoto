// Path rules shared by the server (X-Robots-Tag, sitemap) and the client
// (canonical links). Pure — no Nitro / Nuxt imports.

/** Paths that are never indexed: documents, render page, document API. */
const NOINDEX_PREFIXES = ['/d/', '/_internal/', '/api/docs/'] as const

/** Request path without query string or fragment. */
export function pathnameOf(path: string): string {
  const cut = path.search(/[?#]/)
  return cut === -1 ? path : path.slice(0, cut)
}

/** True for paths that get `X-Robots-Tag: noindex, nofollow` on every instance. */
export function isNoindexPath(path: string): boolean {
  const pathname = pathnameOf(path)
  if (pathname === '/d') return true
  return NOINDEX_PREFIXES.some(p => pathname.startsWith(p))
}

/** True for the docs site (`/docs` and everything under it). */
export function isDocsPath(path: string): boolean {
  const pathname = pathnameOf(path)
  return pathname === '/docs' || pathname.startsWith('/docs/')
}

export interface CanonicalOrigins {
  /** This instance's public origin (`NUXT_SITE_URL`); '' = unknown. */
  siteUrl: string
  /** Origin for `/docs/**` canonicals; '' = `siteUrl`. */
  docsCanonicalBase: string
}

/**
 * Absolute canonical URL for a route path, or null when none should be
 * emitted: noindex paths (documents) and instances without a configured
 * site URL (never guessed from the request Host). Query string and
 * fragment are dropped; trailing slashes are removed (except on `/`).
 * `/docs/**` uses the docs canonical base when one is set, so a
 * self-hosted copy of the docs points at markoto.app.
 */
export function canonicalUrl(path: string, origins: CanonicalOrigins): string | null {
  if (isNoindexPath(path)) return null
  let pathname = pathnameOf(path)
  if (!pathname.startsWith('/')) pathname = `/${pathname}`
  while (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1)
  const origin = isDocsPath(pathname) && origins.docsCanonicalBase
    ? origins.docsCanonicalBase
    : origins.siteUrl
  if (!origin) return null
  return `${origin}${pathname}`
}
