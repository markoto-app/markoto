import type { FeatureSpendRow } from '../../repos/litellmSpend'
import { ALL_FEATURE_TAGS, type FeatureTag } from './featureTags'

// Shapes the admin spend dashboard's table (`/api/admin/ai-spend` and
// `/api/admin/axis-spend`) from spend-log groups (`spendByFeature`), where
// every logged call sits in exactly one group. The totals are the sum over
// the calls, so they match `LiteLLM_SpendLogs` for the window; "other" holds
// the calls without a known feature tag (a call site that forgot to stamp
// one, or a feature tag missing from `FEATURE_TAGS`).

export interface SpendBreakdownRow {
  tag: FeatureTag | 'other'
  spendUsd: number
  requests: number
  totalTokens: number
  sharePct: number
}

export interface SpendBreakdown {
  totalSpendUsd: number
  totalRequests: number
  breakdown: SpendBreakdownRow[]
}

interface Totals { spend: number, requests: number, totalTokens: number }

const KNOWN_TAGS = new Set<string>(ALL_FEATURE_TAGS)

function add(into: Totals, row: FeatureSpendRow): void {
  into.spend += Number(row.spend)
  into.requests += Number(row.requests)
  into.totalTokens += Number(row.total_tokens)
}

/** Canonical feature rows (zero rows included), then "other" when it has any calls. */
export function buildSpendBreakdown(rows: FeatureSpendRow[]): SpendBreakdown {
  const byTag = new Map<string, Totals>()
  const other: Totals = { spend: 0, requests: 0, totalTokens: 0 }
  const total: Totals = { spend: 0, requests: 0, totalTokens: 0 }
  for (const row of rows) {
    add(total, row)
    const tag = row.feature_tag
    if (tag === null || !KNOWN_TAGS.has(tag)) {
      add(other, row)
      continue
    }
    const existing = byTag.get(tag) ?? { spend: 0, requests: 0, totalTokens: 0 }
    add(existing, row)
    byTag.set(tag, existing)
  }

  const shaped: Array<{ tag: FeatureTag | 'other' } & Totals> = ALL_FEATURE_TAGS.map(tag => ({
    tag,
    ...(byTag.get(tag) ?? { spend: 0, requests: 0, totalTokens: 0 })
  }))
  if (other.requests > 0) shaped.push({ tag: 'other', ...other })

  return {
    totalSpendUsd: Number(total.spend.toFixed(4)),
    totalRequests: total.requests,
    breakdown: shaped.map(r => ({
      tag: r.tag,
      spendUsd: Number(r.spend.toFixed(4)),
      requests: r.requests,
      totalTokens: r.totalTokens,
      sharePct: total.spend > 0 ? Number(((r.spend / total.spend) * 100).toFixed(2)) : 0
    }))
  }
}
