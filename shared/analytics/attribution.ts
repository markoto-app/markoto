// Ad-click attribution: the Google Ads click id and the UTM parameters of
// the landing URL. Read in the browser from the URL the visitor arrived on,
// kept in memory only (never written to cookies or web storage), and sent
// to the server only together with a request that is itself a conversion
// (sign-up, waitlist sign-up, document creation). The server keeps it for
// the Google Ads offline conversion upload and deletes it after 90 days.
// docs/SELF-HOSTING.md#analytics-optional explains the design and its legal basis.

import { z } from 'zod'

/** Google Ads click ids, in the order they are preferred when several are present. */
export const CLICK_ID_PARAMS = ['gclid', 'gbraid', 'wbraid'] as const
export type ClickIdType = typeof CLICK_ID_PARAMS[number]

export const UTM_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const
export type UtmParam = typeof UTM_PARAMS[number]
export type Utm = Partial<Record<UtmParam, string>>

/**
 * Click ids are opaque base64url-like tokens (Google documents no format).
 * The bound keeps a pasted URL from smuggling arbitrary text into a row.
 */
const CLICK_ID_RE = /^[\w.-]{8,512}$/
/** UTM values are campaign labels: printable, short. */
const UTM_MAX_LENGTH = 100
// Letters, digits, spaces and common label punctuation; nothing that could
// be a formula or markup in a report export.
const UTM_RE = /^[\p{L}\p{N} _.,:/|()+-]+$/u

export interface ClickId {
  type: ClickIdType
  value: string
}

export interface Attribution {
  clickId: ClickId | null
  utm: Utm
}

type QueryLike = Record<string, unknown>

function first(value: unknown): string | null {
  const v = Array.isArray(value) ? value[0] : value
  return typeof v === 'string' ? v.trim() : null
}

/** A click id from a query string record, or null. Only well-formed ids count. */
export function clickIdFromQuery(query: QueryLike): ClickId | null {
  for (const type of CLICK_ID_PARAMS) {
    const value = first(query[type])
    if (value && CLICK_ID_RE.test(value)) return { type, value }
  }
  return null
}

/** A UTM value, or null when it is empty, too long or not a plain label. */
export function cleanUtmValue(raw: unknown): string | null {
  const value = first(raw)
  if (!value || value.length > UTM_MAX_LENGTH || !UTM_RE.test(value)) return null
  if (/^[=+@-]/.test(value)) return null
  return value
}

export function utmFromQuery(query: QueryLike): Utm {
  const utm: Utm = {}
  for (const key of UTM_PARAMS) {
    const value = cleanUtmValue(query[key])
    if (value) utm[key] = value
  }
  return utm
}

export function attributionFromQuery(query: QueryLike): Attribution {
  return { clickId: clickIdFromQuery(query), utm: utmFromQuery(query) }
}

/** URLSearchParams → the record the helpers above read. */
export function searchToQuery(search: string): QueryLike {
  const out: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(search)) {
    if (!(k in out)) out[k] = v
  }
  return out
}

/**
 * The click id as a request body field (`attribution` on POST /api/docs and
 * POST /api/waitlist). Malformed input is dropped, never an error: the
 * request itself must not fail over its attribution.
 */
export const clickIdBody = z.object({
  type: z.enum(CLICK_ID_PARAMS),
  value: z.string().regex(CLICK_ID_RE)
}).nullish().catch(null)

/** Query parameters the sign-in links carry the click id in (`/auth/google?gclid=…`). */
export function clickIdQuery(clickId: ClickId | null): Record<string, string> {
  return clickId ? { [clickId.type]: clickId.value } : {}
}
