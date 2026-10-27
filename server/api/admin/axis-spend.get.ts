import { Pool } from 'pg'
import { requireAdminUser } from '../../utils/adminAccess'
import { litellmDbUrl } from '../../utils/litellm/litellmDb'
import { ALL_FEATURE_TAGS, type FeatureTag } from '../../utils/litellm/featureTags'

// Per-axis spend filter: returns the spend breakdown for ONE entity
// of one axis (workspace, user, or doc), broken down by feature.
// Drives the operator dashboard's per-entity drill-down.
//
// Implementation note: LiteLLM's `/spend/tags` endpoint returns
// per-tag totals but NOT cross-tabs — querying it with `tags=doc:X`
// gives the doc total, but can't give "doc:X spend split by feature".
// We get the cross-tab by querying `LiteLLM_SpendLogs` directly with
// a JSONB filter on `request_tags`: rows where `request_tags` contains
// the axis tag, grouped by which feature tag co-occurs.
//
// Same Postgres connection pattern as `spendLogsSweep.ts` — the proxy
// owns the table, but it has no write coordination on read-only
// SELECTs so the cross-process query is safe. Bounded by the date
// window so a sloppy operator can't accidentally scan all-time.

interface CliQuery {
  axis: 'workspace' | 'user' | 'doc'
  value: string
  from: string
  to: string
}

const VALID_AXES = ['workspace', 'user', 'doc'] as const
type Axis = typeof VALID_AXES[number]

let cachedPool: Pool | null = null

function pool(): Pool {
  if (cachedPool) return cachedPool
  cachedPool = new Pool({
    connectionString: litellmDbUrl(),
    max: 2,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 5000
  })
  return cachedPool
}

/** Test-only: drop the cached pool. */
export function _resetAxisSpendPool(): void {
  if (cachedPool) {
    void cachedPool.end()
    cachedPool = null
  }
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
  const axisParam = query.axis
  const valueParam = query.value
  if (typeof axisParam !== 'string' || !VALID_AXES.includes(axisParam as Axis)) {
    throw createError({
      statusCode: 400,
      message: `axis must be one of: ${VALID_AXES.join(', ')}`
    })
  }
  if (typeof valueParam !== 'string' || valueParam.length === 0) {
    throw createError({ statusCode: 400, message: 'value is required' })
  }
  if (valueParam.length > 64) {
    throw createError({ statusCode: 400, message: 'value too long' })
  }

  const opts: CliQuery = {
    axis: axisParam as Axis,
    value: valueParam,
    from: isValidIsoDate(query.from) ? query.from : defaultRange().from,
    to: isValidIsoDate(query.to) ? query.to : defaultRange().to
  }
  const filterTag = `${opts.axis}:${opts.value}`

  // Cross-tab aggregation. For every row in the window where the
  // request_tags array contains the axis tag, sum spend per
  // co-occurring feature tag. The `?` operator on a JSONB array tests
  // element-equality. Date filter on `startTime` cuts the scan to
  // the window — without it, scans all-time on every dashboard load.
  type Row = { feature_tag: string, spend: string, requests: string, total_tokens: string }
  const rows = await pool().query<Row>(
    `
    WITH matched AS (
      SELECT spend, total_tokens, request_tags AS tags
      FROM "LiteLLM_SpendLogs"
      WHERE "startTime" >= $2::timestamp
        AND "startTime" < ($3::date + INTERVAL '1 day')
        AND request_tags ? $1
    ),
    feature_rows AS (
      -- Unnest the tags array; keep only feature-prefixed entries
      -- so we filter out the sibling axes (workspace, user, doc).
      SELECT jsonb_array_elements_text(tags) AS feature_tag, spend, total_tokens
      FROM matched
    )
    SELECT
      feature_tag,
      SUM(spend)::float8 AS spend,
      COUNT(*)::bigint AS requests,
      SUM(total_tokens)::bigint AS total_tokens
    FROM feature_rows
    WHERE feature_tag LIKE 'feature:%'
    GROUP BY feature_tag
    `,
    [filterTag, opts.from, opts.to]
  )

  const byTag = new Map<string, { spend: number, requests: number, totalTokens: number }>()
  for (const r of rows.rows) {
    byTag.set(r.feature_tag, {
      spend: Number(r.spend ?? 0),
      requests: Number(r.requests ?? 0),
      totalTokens: Number(r.total_tokens ?? 0)
    })
  }

  // Total: spend across every feature row (which is also the entity's
  // total since we filtered to the axis tag).
  const totalSpend = Array.from(byTag.values()).reduce((s, r) => s + r.spend, 0)
  const totalRequests = Array.from(byTag.values()).reduce((s, r) => s + r.requests, 0)

  // Canonical-order breakdown — every feature gets a row, zero-spend
  // when missing. Same shape as `/api/admin/ai-spend` so the dashboard
  // can render both with one component.
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
})
