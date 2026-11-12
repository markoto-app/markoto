import { z } from 'zod'
import { litellmAdminFetch } from '../../utils/litellm/litellmAdmin'
import { ALL_FEATURE_TAGS, TAG_NAMESPACES, type FeatureTag } from '../../utils/litellm/featureTags'
import { DAY_MS } from '~~/shared/config/units'
import { aiSpendQuery } from '~~/shared/api/legal'

// Operator dashboard (/admin/ai-spend, admin-gated): per-feature LiteLLM spend
// over a date window, aggregated by the proxy via /spend/tags.
//
// Window defaults to the last 30 days; `?from=YYYY-MM-DD&to=YYYY-MM-DD`
// override it. Invalid dates fall back to the default rather than 400, so a
// typo'd URL still shows a chart.

/** Internal shape — collapsed from LiteLLM's response into a tag-keyed map. */
type SpendByTag = Record<string, { spend: number, requests: number, totalTokens: number }>

const spendNumber = z.number().optional().catch(undefined)
/** A row of the array shape (one per tag, possibly repeated). */
const spendTagRow = z.object({
  individual_request_tag: z.string(),
  total_spend: spendNumber,
  log_count: spendNumber,
  total_tokens: spendNumber
})
/** A value of the map shape: `total_spend`/`spend`, `log_count`/`api_requests` are alternative names. */
const spendMapEntry = z.object({
  total_spend: spendNumber,
  spend: spendNumber,
  log_count: spendNumber,
  api_requests: spendNumber,
  total_tokens: spendNumber
}).catch({})

/**
 * LiteLLM's `/spend/tags` returns an array of rows, or the same wrapped as
 * `{ spend_per_tag: [...] }`, or a tag-keyed map depending on version.
 * All shapes collapse into one internal map.
 */
function collapseSpendResponse(payload: unknown): SpendByTag {
  const body = unwrapEnvelope(payload)
  if (Array.isArray(body)) return collapseArrayShape(body)
  const map = z.record(z.string(), spendMapEntry).safeParse(body)
  return map.success ? collapseMapShape(map.data) : {}
}

function unwrapEnvelope(payload: unknown): unknown {
  if (payload && typeof payload === 'object' && 'spend_per_tag' in payload) return payload.spend_per_tag
  return payload
}

/** Array shape: multiple rows for the same tag sum; rows without a tag are skipped. */
function collapseArrayShape(rows: unknown[]): SpendByTag {
  const out: SpendByTag = {}
  for (const raw of rows) {
    const row = spendTagRow.safeParse(raw)
    if (!row.success) continue
    const tag = row.data.individual_request_tag
    const existing = out[tag] ?? { spend: 0, requests: 0, totalTokens: 0 }
    existing.spend += row.data.total_spend ?? 0
    existing.requests += row.data.log_count ?? 0
    existing.totalTokens += row.data.total_tokens ?? 0
    out[tag] = existing
  }
  return out
}

/** Map shape: the first defined of the alternative field names wins. */
function collapseMapShape(rows: Record<string, z.infer<typeof spendMapEntry>>): SpendByTag {
  const out: SpendByTag = {}
  for (const [tag, row] of Object.entries(rows)) {
    out[tag] = {
      spend: row.total_spend ?? row.spend ?? 0,
      requests: row.log_count ?? row.api_requests ?? 0,
      totalTokens: row.total_tokens ?? 0
    }
  }
  return out
}

function defaultRange(): { from: string, to: string } {
  const today = new Date()
  const past = new Date(today.getTime() - 30 * DAY_MS)
  return {
    from: past.toISOString().slice(0, 10),
    to: today.toISOString().slice(0, 10)
  }
}

export default defineApiHandler({
  access: allow.admin(),
  query: aiSpendQuery,
  handler: async ({ query }) => {
    const from = query.from ?? defaultRange().from
    const to = query.to ?? defaultRange().to

    // No `tags=` filter: unknown tags are wanted too, for the "other" row.
    const url = `/spend/tags?start_date=${encodeURIComponent(from)}&end_date=${encodeURIComponent(to)}`
    const res = await litellmAdminFetch(url)
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      // The upstream text stays in the server log (the cause); the client only learns the status.
      throw apiError('admin/spend-unavailable', { upstreamStatus: res.status }, { cause: new Error(`LiteLLM /spend/tags failed: ${res.status} ${text.slice(0, 200)}`) })
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
  }
})
