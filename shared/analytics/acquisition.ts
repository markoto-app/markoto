// Acquisition source: which site brought a visitor, as one coarse category
// from a fixed list (never the raw URL, referrer or campaign label).
//
// Read in the browser from the landing URL (`?ref=producthunt`, else
// `utm_source`) or the referring site, kept in memory only, and sent with
// the requests that are themselves funnel steps (a new document, the
// sign-in link). The server stores the category on the anonymous document
// and on a new account, so the admin's "Funnel by source" works from the
// database even where an ad blocker stops the statistics requests.
// docs/contributing/admin-metrics.md#funnel-by-source explains the numbers.

import { z } from 'zod'

export const ACQUISITION_SOURCES = ['producthunt', 'hackernews', 'google', 'github', 'other'] as const
export type AcquisitionSource = typeof ACQUISITION_SOURCES[number]

/** The funnel's rows: every stored source plus `direct` (no source known). */
export const FUNNEL_SOURCES = [...ACQUISITION_SOURCES, 'direct'] as const
export type FunnelSource = typeof FUNNEL_SOURCES[number]

/** Query parameter of a launch link (`/?ref=producthunt`), also carried on sign-in links. */
export const SOURCE_PARAM = 'ref'

/** Query parameter the sign-in callback adds for the client's `signup_completed` event. */
export const SIGNED_UP_SOURCE_PARAM = 'signed_up_source'

const SOURCE_SET: ReadonlySet<string> = new Set(ACQUISITION_SOURCES)

/** Labels people put into `ref` / `utm_source`, folded to lowercase letters and digits. */
const LABEL_ALIASES: Record<string, AcquisitionSource> = {
  producthunt: 'producthunt',
  producthuntcom: 'producthunt',
  ph: 'producthunt',
  hackernews: 'hackernews',
  hn: 'hackernews',
  ycombinator: 'hackernews',
  newsycombinatorcom: 'hackernews',
  google: 'google',
  googlecom: 'google',
  googleads: 'google',
  github: 'github',
  githubcom: 'github'
}

const MAX_LABEL_LENGTH = 100

function first(value: unknown): string | null {
  const v = Array.isArray(value) ? value[0] : value
  return typeof v === 'string' ? v.trim() : null
}

/** A stored or transmitted value, accepted only when it is exactly one of the categories. */
export function parseAcquisitionSource(value: unknown): AcquisitionSource | null {
  return typeof value === 'string' && SOURCE_SET.has(value) ? value as AcquisitionSource : null
}

/**
 * A free-form `ref` / `utm_source` label as a category: a known label is
 * its source, any other non-empty label is `other`, nothing is null.
 */
export function sourceFromLabel(raw: unknown): AcquisitionSource | null {
  const value = first(raw)
  if (!value || value.length > MAX_LABEL_LENGTH) return null
  const folded = value.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[^a-z0-9]/g, '')
  if (!folded) return null
  return LABEL_ALIASES[folded] ?? 'other'
}

/** A referring host as a category; null for none or this site itself. */
export function sourceFromReferrerHost(host: string | null | undefined, ownHost: string): AcquisitionSource | null {
  const h = (host ?? '').toLowerCase().replace(/\.$/, '')
  if (!h || h === ownHost.toLowerCase()) return null
  const is = (domain: string) => h === domain || h.endsWith(`.${domain}`)
  if (is('producthunt.com')) return 'producthunt'
  if (is('ycombinator.com')) return 'hackernews'
  if (is('github.com')) return 'github'
  // google.com, google.de, google.co.uk, …
  if (/(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(h)) return 'google'
  return 'other'
}

/** A referrer URL (`document.referrer`) as a category. */
export function sourceFromReferrer(referrer: string, ownHost: string): AcquisitionSource | null {
  if (!referrer) return null
  try {
    const u = new URL(referrer)
    if (!/^https?:$/.test(u.protocol)) return null
    return sourceFromReferrerHost(u.hostname, ownHost)
  } catch {
    return null
  }
}

export interface LandingContext {
  query: Record<string, unknown>
  /** `document.referrer`, or the referring domain alone. */
  referrer: string
  ownHost: string
}

/**
 * The source of a landing: `ref` first (our own launch links), then
 * `utm_source`, then the referring site. Null = direct.
 */
export function acquisitionSourceOf(ctx: LandingContext): AcquisitionSource | null {
  return sourceFromLabel(ctx.query[SOURCE_PARAM])
    ?? sourceFromLabel(ctx.query.utm_source)
    ?? (ctx.referrer.includes('/') ? sourceFromReferrer(ctx.referrer, ctx.ownHost) : sourceFromReferrerHost(ctx.referrer, ctx.ownHost))
}

/** A stored source as a funnel row (null = direct). */
export function funnelSourceOf(source: string | null | undefined): FunnelSource {
  return parseAcquisitionSource(source) ?? 'direct'
}

/**
 * The source as a request body field (`acquisitionSource` on POST
 * /api/docs). Anything outside the list is dropped, never an error.
 */
export const acquisitionSourceBody = z.enum(ACQUISITION_SOURCES).nullish().catch(null)
