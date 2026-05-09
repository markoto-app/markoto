import { requireAdminUser } from '../../utils/adminAccess'
import { litellmAdminFetch } from '../../utils/litellm/litellmAdmin'
import { ALL_FEATURE_TAGS, TAG_NAMESPACES, type FeatureTag } from '../../utils/litellm/featureTags'

// Operator dashboard: per-feature LiteLLM spend over a date window.
// Drives /admin/ai-spend (admin-gated). Aggregation lives at the
// proxy via /spend/tags — we just request the breakdown for the
// known tag set and shape the response for the UI.
//
// Window: defaults to the last 30 days. Caller can override with
// `?from=YYYY-MM-DD&to=YYYY-MM-DD` query params; both must be valid
// ISO date strings (YYYY-MM-DD), otherwise we fall back to the
// 30-day default rather than 400 (operators land on a chart, not
// an error, when they typo a URL).

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
 * LiteLLM's `/spend/tags` returns an array of `{individual_request_tag,
 * total_spend, log_count, ...}` rows. Some versions return the same
 * data wrapped as `{ spend_per_tag: [...] }`. Collapse both shapes
 * (and the historic keyed-map shape that some callers documented)
 * into a single internal map.
 */
function collapseSpendResponse(payload: unknown): SpendByTag {
  const out: SpendByTag = {}
  // Unwrap envelope variants.
  let body: unknown = payload
  if (payload && typeof payload === 'object' && 'spend_per_tag' in payload) {
    body = (payload as { spend_per_tag?: unknown }).spend_per_tag
  }
  // Array shape (current).
  if (Array.isArray(body)) {
    for (const row of body as SpendTagRow[]) {
      if (typeof row?.individual_request_tag !== 'string') continue
      const tag = row.individual_request_tag
      const existing = out[tag] ?? { spend: 0, requests: 0, totalTokens: 0 }
      existing.spend += typeof row.total_spend === 'number' ? row.total_spend : 0
      existing.requests += typeof row.log_count === 'number' ? row.log_count : 0
      existing.totalTokens += typeof row.total_tokens === 'number' ? row.total_tokens : 0
      out[tag] = existing
    }
    return out
  }
  // Map shape (legacy / some versions).
  if (body && typeof body === 'object') {
    for (const [tag, row] of Object.entries(body as Record<string, SpendTagRow>)) {
      out[tag] = {
        spend: typeof row?.total_spend === 'number'
          ? row.total_spend
          : typeof (row as unknown as { spend?: number })?.spend === 'number'
            ? (row as unknown as { spend: number }).spend
            : 0,
        requests: typeof row?.log_count === 'number'
          ? row.log_count
          : typeof (row as unknown as { api_requests?: number })?.api_requests === 'number'
            ? (row as unknown as { api_requests: number }).api_requests
            : 0,
        totalTokens: typeof row?.total_tokens === 'number' ? row.total_tokens : 0
      }
    }
  }
  return out
}

function isValidIsoDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
}

function defaultRange(): { from: string, to: string } {
  const today = new Date()
  const past = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000)
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

  // LiteLLM's /spend/tags endpoint accepts optional `tags` (CSV) +
  // `start_date` / `end_date` (YYYY-MM-DD). We don't pass `tags=`
  // because we want unknown tags too (so we can show "other").
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

  // Bucket: known feature tags get their own row (in the canonical
  // order so the dashboard renders consistently); unknown feature-
  // shaped tags fold into `other`.
  const knownSet = new Set<string>(ALL_FEATURE_TAGS)
  const breakdown: Array<{ tag: FeatureTag | 'other', spend: number, requests: number, totalTokens: number }> = []

  for (const tag of ALL_FEATURE_TAGS) {
    const row = tagMap[tag] ?? { spend: 0, requests: 0, totalTokens: 0 }
    breakdown.push({ tag, spend: row.spend, requests: row.requests, totalTokens: row.totalTokens })
  }

  // Sweep up everything the proxy returned that ISN'T one of our
  // known feature tags into a single `other` row. The workspace:* /
  // user:* / doc:* axes are also known namespaces — they're queried
  // through dedicated endpoints (`/admin/axis-spend`) and would just
  // inflate "other" if we counted them here, so we skip them.
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
