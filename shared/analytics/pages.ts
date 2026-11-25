// Which pages are counted, and what the analytics endpoint receives.
// Only the public site is counted: documents (/d/…), published pages
// (/p/…), workspaces, settings, admin, sign-in and token links never are,
// and no URL ever carries more than its path plus the UTM parameters and
// the coarse acquisition source (`ref`, shared/analytics/acquisition.ts).

import { UTM_PARAMS, type Utm } from './attribution'
import { SOURCE_PARAM, type AcquisitionSource } from './acquisition'
import type { ResolvedEvent } from './events'

/** Paths (and their sub-paths) that are never counted as page views. */
const NEVER_TRACKED = ['/d', '/p', '/w', '/settings', '/admin', '/auth', '/api', '/_internal', '/invites', '/waitlist/unsubscribe', '/docs/_internal']
const MAX_PATH_LENGTH = 200

/** Placeholder path for events fired inside the app (an editor URL names the document). */
export const APP_PATH = '/app'

/** The path a page view is counted under, or null when the page is not counted. */
export function trackablePath(path: string): string | null {
  const clean = path.split(/[?#]/)[0] ?? ''
  if (!clean.startsWith('/') || clean.length > MAX_PATH_LENGTH) return null
  if (NEVER_TRACKED.some(p => clean === p || clean.startsWith(`${p}/`))) return null
  // Trailing slash folded so `/pricing/` and `/pricing` are one page.
  let end = clean.length
  while (end > 1 && clean[end - 1] === '/') end--
  return clean.slice(0, end)
}

/** Only the origin of an external referrer (a search page URL can hold the query). */
export function referrerOrigin(referrer: string, ownHost: string): string | undefined {
  if (!referrer) return undefined
  try {
    const u = new URL(referrer)
    if (u.hostname === ownHost || !/^https?:$/.test(u.protocol)) return undefined
    return `${u.protocol}//${u.host}/`
  } catch {
    return undefined
  }
}

export interface CollectContext {
  websiteId: string
  hostname: string
  language: string
  screen: string
  /** Current route path; reduced to `trackablePath` or `APP_PATH`. */
  path: string
  title: string
  referrer: string
  utm: Utm
  /** The visit's acquisition source, sent as `ref=<source>` (one of a fixed list). */
  ref?: AcquisitionSource | null
}

export interface CollectPayload {
  type: 'event'
  payload: {
    website: string
    hostname: string
    language: string
    screen: string
    url: string
    title?: string
    referrer?: string
    name?: string
    data?: Record<string, string | number | boolean>
  }
}

function urlWithUtm(path: string, utm: Utm, ref: AcquisitionSource | null | undefined): string {
  const params = new URLSearchParams()
  for (const key of UTM_PARAMS) {
    const v = utm[key]
    if (v) params.set(key, v)
  }
  if (ref) params.set(SOURCE_PARAM, ref)
  const q = params.toString()
  return q ? `${path}?${q}` : path
}

/**
 * The body of one Umami `/api/send` request: a page view (no `event`) or a
 * named event. Inside the app (not a counted page) the URL is `APP_PATH`
 * and no title is sent, so a document's id and title never leave.
 */
export function buildCollectPayload(ctx: CollectContext, event?: ResolvedEvent): CollectPayload {
  const counted = trackablePath(ctx.path)
  const path = counted ?? APP_PATH
  return {
    type: 'event',
    payload: {
      website: ctx.websiteId,
      hostname: ctx.hostname,
      language: ctx.language.slice(0, 35),
      screen: ctx.screen,
      url: urlWithUtm(path, ctx.utm, ctx.ref),
      ...(counted && ctx.title ? { title: ctx.title.slice(0, 200) } : {}),
      ...(counted ? { referrer: referrerOrigin(ctx.referrer, ctx.hostname) } : {}),
      ...(event ? { name: event.name, ...(event.data ? { data: event.data } : {}) } : {})
    }
  }
}

/** The visitor asked not to be tracked (Global Privacy Control or Do Not Track). */
export function optedOutOfTracking(nav: { globalPrivacyControl?: unknown, doNotTrack?: unknown } | undefined, win?: { doNotTrack?: unknown }): boolean {
  if (!nav) return true
  return nav.globalPrivacyControl === true || nav.doNotTrack === '1' || nav.doNotTrack === 'yes' || win?.doNotTrack === '1'
}

/** The same signals as request headers (`Sec-GPC: 1`, `DNT: 1`). */
export function optedOutByHeaders(get: (name: string) => string | null | undefined): boolean {
  return get('sec-gpc')?.trim() === '1' || get('dnt')?.trim() === '1'
}
