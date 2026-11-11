// Publish as a web page. Shared by the publish endpoints, the
// published-page route and the publish dialog.

/** A page slug: lowercase letters, digits, single hyphens, 3–60 chars. */
export const PUBLISH_SLUG_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,59}$/

/** Published pages live under this path on the instance's own host. */
export const PUBLISHED_PAGE_PREFIX = '/p/'

/** A published page id (nanoid 16). */
export const PUBLISHED_PAGE_ID_RE = /^[A-Za-z0-9_-]{16}$/

/** Published file names: an upload's file id or a brand asset's file. */
export const PUBLISHED_FILE_RE = /^[A-Za-z0-9_-]{1,64}\.(?:png|jpe?g|gif|webp|woff2|woff|ttf)$/

/** Upper bound for a snapshot (HTML + CSS), stored in Postgres. */
export const PUBLISH_MAX_SNAPSHOT_CHARS = 8 * 1024 * 1024

/** Publishes (incl. re-publishes) per user per hour. */
export const PUBLISH_RATE_PER_HOUR = 30

export const PUBLISH_ERROR_CODES = {
  slugTaken: 'publish/slug-taken',
  slugInvalid: 'publish/slug-invalid',
  notPublished: 'publish/not-published',
  tooLarge: 'publish/too-large',
  renderFailed: 'publish/render-failed',
  busy: 'publish/busy'
} as const

/** URL of a published page's copied file, as written into its HTML / CSS. */
export function publishedFileUrl(pageId: string, kind: 'files' | 'brand', file: string): string {
  return `/api/published/${pageId}/${kind}/${file}`
}

/**
 * A slug proposal from a title: ASCII-folded, lowercase, hyphenated, at
 * most 48 chars, with a short random suffix so two "Untitled" pages don't
 * collide. The caller retries with a new suffix on a (rare) clash.
 */
export function slugFromTitle(title: string, suffix: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return base.length >= 3 ? `${base}-${suffix}` : `page-${suffix}`
}
