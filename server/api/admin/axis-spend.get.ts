import { spendByFeatureForTag } from '../../repos/litellmSpend'
import { ALL_FEATURE_TAGS, type FeatureTag } from '../../utils/litellm/featureTags'
import { DAY_MS } from '~~/shared/config/units'
import { axisSpendQuery } from '~~/shared/api/legal'

// Spend breakdown by feature for ONE entity of one axis (workspace, user or
// doc); drives the operator dashboard's drill-down.
//
// `/spend/tags` has per-tag totals but no cross-tabs, so this queries
// `LiteLLM_SpendLogs` directly (`repos/litellmSpend.ts`) with a JSONB filter
// on `request_tags`, bounded by the date window.

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
  query: axisSpendQuery,
  handler: async ({ query, adminActor }) => {
    const opts = {
      axis: query.axis,
      value: query.value,
      from: query.from ?? defaultRange().from,
      to: query.to ?? defaultRange().to
    }
    const filterTag = `${opts.axis}:${opts.value}`

    // Spend per feature tag co-occurring with the axis tag.
    const rows = await spendByFeatureForTag(adminActor, filterTag, opts.from, opts.to)

    const byTag = new Map<string, { spend: number, requests: number, totalTokens: number }>()
    for (const r of rows) {
      byTag.set(r.feature_tag, {
        spend: Number(r.spend ?? 0),
        requests: Number(r.requests ?? 0),
        totalTokens: Number(r.total_tokens ?? 0)
      })
    }

    // Total over every feature row (the query is already filtered to the axis tag).
    const totalSpend = Array.from(byTag.values()).reduce((s, r) => s + r.spend, 0)
    const totalRequests = Array.from(byTag.values()).reduce((s, r) => s + r.requests, 0)

    // Canonical order, zero-spend rows included; same shape as
    // `/api/admin/ai-spend` so one dashboard component renders both.
    const breakdown = ALL_FEATURE_TAGS.map((tag): {
      tag: FeatureTag
      spendUsd: number
      requests: number
      totalTokens: number
      sharePct: number
    } => {
      const row = byTag.get(tag) ?? { spend: 0, requests: 0, totalTokens: 0 }
      return {
        tag,
        spendUsd: Number(row.spend.toFixed(4)),
        requests: row.requests,
        totalTokens: row.totalTokens,
        sharePct: totalSpend > 0 ? Number(((row.spend / totalSpend) * 100).toFixed(2)) : 0
      }
    })

    return {
      axis: opts.axis,
      value: opts.value,
      from: opts.from,
      to: opts.to,
      totalSpendUsd: Number(totalSpend.toFixed(4)),
      totalRequests,
      breakdown
    }
  }
})
