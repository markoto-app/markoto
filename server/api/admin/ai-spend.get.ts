import { requireAdminUser } from '../../utils/auth/adminAccess'
import { litellmAdminFetch } from '../../utils/litellm/litellmAdmin'
import { ALL_FEATURE_TAGS, TAG_NAMESPACES, type FeatureTag } from '../../utils/litellm/featureTags'
import { DAY_MS } from '~~/shared/config/units'

// Operator dashboard (/admin/ai-spend, admin-gated): per-feature LiteLLM spend
// over a date window, aggregated by the proxy via /spend/tags.
//
// Window defaults to the last 30 days; `?from=YYYY-MM-DD&to=YYYY-MM-DD`
// override it. Invalid dates fall back to the default rather than 400, so a
// typo'd URL still shows a chart.

interface SpendTagRow {
  individual_request_tag?: string
  total_spend?: number
  log_count?: number
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

/** Internal shape — collapsed from LiteLLM's response into a tag-keyed map. */
type SpendByTag = Record<string, { spend: number, requests: number, totalTokens: number }>

/**
 * LiteLLM's `/spend/tags` returns an array of rows, or the same wrapped as
 * `{ spend_per_tag: [...] }`, or a tag-keyed map depending on version.
 * All shapes collapse into one internal map.
 */
function collapseSpendResponse(payload: unknown): SpendByTag {
  const body = unwrapEnvelope(payload)
  if (Array.isArray(body)) return collapseArrayShape(body)
  if (body && typeof body === 'object') return collapseMapShape(body as Record<string, unknown>)
  return {}
}

function unwrapEnvelope(payload: unknown): unknown {
  if (payload && typeof payload === 'object' && 'spend_per_tag' in payload) {
    return (payload as { spend_per_tag?: unknown }).spend_per_tag
  }
  return payload
}

function num(row: unknown, key: string): number {
  if (!row || typeof row !== 'object') return 0
  const v = (row as Record<string, unknown>)[key]
  return typeof v === 'number' ? v : 0
}

/** Pick the first numeric field from a list of candidate keys; 0 if none match. */
function firstNum(row: unknown, keys: string[]): number {
  if (!row || typeof row !== 'object') return 0
  const r = row as Record<string, unknown>
  for (const k of keys) {
    const v = r[k]
    if (typeof v === 'number') return v
  }
  return 0
}

/** Array shape: multiple rows for the same tag sum. */
function collapseArrayShape(rows: unknown[]): SpendByTag {
  const out: SpendByTag = {}
  for (const row of rows as SpendTagRow[]) {
    if (typeof row?.individual_request_tag !== 'string') continue
    const tag = row.individual_request_tag
    const existing = out[tag] ?? { spend: 0, requests: 0, totalTokens: 0 }
    existing.spend += num(row, 'total_spend')
    existing.requests += num(row, 'log_count')
    existing.totalTokens += num(row, 'total_tokens')
    out[tag] = existing
  }
  return out
}

/**
 * Map shape: `total_spend`/`spend` and `log_count`/`api_requests` are
 * alternative field names; the first defined wins.
 */
function collapseMapShape(rows: Record<string, unknown>): SpendByTag {
  const out: SpendByTag = {}
  for (const [tag, row] of Object.entries(rows)) {
    out[tag] = {
      spend: firstNum(row, ['total_spend', 'spend']),
      requests: firstNum(row, ['log_count', 'api_requests']),
      totalTokens: num(row, 'total_tokens')
    }
  }
  return out
}

function isValidIsoDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
}

function defaultRange(): { from: string, to: string } {
  const today = new Date()
  const past = new Date(today.getTime() - 30 * DAY_MS)
  return {
    from: past.toISOString().slice(0, 10),
    to: today.toISOString().slice(0, 10)
  }
}

export default defineEventHandler(async (event) => {
  await requireAdminUser(event)

  const query = getQuery(event)
  const from = isValidIsoDate(query.from) ? query.from : defaultRange().from
  const to = isValidIsoDate(query.to) ? query.to : defaultRange().to

  // No `tags=` filter: unknown tags are wanted too, for the "other" row.
  const url = `/spend/tags?start_date=${encodeURIComponent(from)}&end_date=${encodeURIComponent(to)}`
  const res = await litellmAdminFetch(url)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw createError({
      statusCode: 502,
      message: `LiteLLM /spend/tags failed: ${res.status} ${text.slice(0, 200)}`
    })
  }
  const tagMap = collapseSpendResponse(await res.json())

  // Known feature tags get their own row in canonical order; unknown
  // feature-shaped tags fold into `other`.
  const knownSet = new Set<string>(ALL_FEATURE_TAGS)
  const breakdown: Array<{ tag: FeatureTag | 'other', spend: number, requests: number, totalTokens: number }> = []

  for (const tag of ALL_FEATURE_TAGS) {
    const row = tagMap[tag] ?? { spend: 0, requests: 0, totalTokens: 0 }
    breakdown.push({ tag, spend: row.spend, requests: row.requests, totalTokens: row.totalTokens })
  }

  // The workspace:* / user:* / doc:* axes are known namespaces served by
  // `/admin/axis-spend`; counting them here would inflate "other".
  let otherSpend = 0
  let otherRequests = 0
  let otherTokens = 0
  for (const [tag, row] of Object.entries(tagMap)) {
    if (knownSet.has(tag)) continue
    if (TAG_NAMESPACES.some(ns => tag.startsWith(ns) && ns !== 'feature:')) continue
    otherSpend += row.spend
    otherRequests += row.requests
    otherTokens += row.totalTokens
  }
  if (otherSpend > 0 || otherRequests > 0) {
    breakdown.push({ tag: 'other', spend: otherSpend, requests: otherRequests, totalTokens: otherTokens })
  }

  const totalSpend = breakdown.reduce((s, r) => s + r.spend, 0)
  const totalRequests = breakdown.reduce((s, r) => s + r.requests, 0)

  return {
    from,
    to,
    totalSpendUsd: Number(totalSpend.toFixed(4)),
    totalRequests,
    breakdown: breakdown.map(r => ({
      tag: r.tag,
      spendUsd: Number(r.spend.toFixed(4)),
      requests: r.requests,
      totalTokens: r.totalTokens,
      sharePct: totalSpend > 0 ? Number(((r.spend / totalSpend) * 100).toFixed(2)) : 0
    }))
  }
})
