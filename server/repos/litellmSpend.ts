import { useLitellmPool } from '../db/litellm'
import type { AdminActor, SystemActor } from './proofs'

// `LiteLLM_SpendLogs` in the LiteLLM proxy's database (its own pool,
// `server/db/litellm.ts`). Raw parameterised SQL: the table belongs to
// LiteLLM (Prisma naming, no drizzle schema here). Every billable AI call
// writes a row; the proxy coordinates nothing else on it, so reads and the
// retention delete are safe.

const TABLE = '"LiteLLM_SpendLogs"'

/** Spend of one key (its hashed id) in [from, to), USD. */
export async function sumKeySpend(keyId: string, from: Date, to: Date): Promise<number> {
  const r = await useLitellmPool().query<{ spend: number | null }>(
    `SELECT coalesce(sum(spend), 0)::float8 AS spend FROM ${TABLE} WHERE api_key = $1 AND "startTime" >= $2 AND "startTime" < $3`,
    [keyId, from, to]
  )
  return Number(r.rows[0]?.spend ?? 0)
}

/** Spend of every key of a LiteLLM team in [from, to), USD. */
export async function sumTeamSpend(teamId: string, from: Date, to: Date): Promise<number> {
  const r = await useLitellmPool().query<{ spend: number | null }>(
    `SELECT coalesce(sum(spend), 0)::float8 AS spend FROM ${TABLE} WHERE team_id = $1 AND "startTime" >= $2 AND "startTime" < $3`,
    [teamId, from, to]
  )
  return Number(r.rows[0]?.spend ?? 0)
}

/** One group of spend-log rows: a feature tag, or `null` for rows without one. bigint columns arrive as strings. */
export interface FeatureSpendRow { feature_tag: string | null, spend: number | string, requests: number | string, total_tokens: number | string, bucket?: string }

/**
 * Spend per `feature:*` tag between two dates (`to` inclusive), optionally
 * only of the calls carrying `axisTag` (e.g. `workspace:<id>`; `?` tests
 * JSONB array membership). Every spend-log row lands in exactly one group:
 * its feature tag, or `null` when it has none. A call carries several tags
 * (`user:`, `doc:`, `workspace:`, LiteLLM's own `User-Agent: ...`), so
 * summing per tag would count one call several times. A row with two
 * feature tags (no call site writes that) goes to the first in sort order.
 * With `bucket`, the groups are also split per UTC day / week / month
 * (`bucket` on each row: the bucket's first day, `YYYY-MM-DD`).
 */
export async function spendByFeature(_by: AdminActor, window: { from: string, to: string, axisTag?: string, bucket?: 'day' | 'week' | 'month' }): Promise<FeatureSpendRow[]> {
  const params = [window.from, window.to]
  let axisFilter = ''
  if (window.axisTag !== undefined) {
    params.push(window.axisTag)
    axisFilter = `AND request_tags ? $${params.length}`
  }
  let bucketColumn = ''
  let bucketGroup = ''
  if (window.bucket !== undefined) {
    params.push(window.bucket)
    bucketColumn = `, date_trunc($${params.length}, "startTime")::date::text AS bucket`
    bucketGroup = ', bucket'
  }
  const r = await useLitellmPool().query<FeatureSpendRow>(
    `
    SELECT
      (
        SELECT min(t.tag)
        FROM jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(request_tags) = 'array' THEN request_tags ELSE '[]'::jsonb END
        ) AS t(tag)
        WHERE t.tag LIKE 'feature:%'
      ) AS feature_tag,
      coalesce(SUM(spend), 0)::float8 AS spend,
      COUNT(*)::bigint AS requests,
      coalesce(SUM(total_tokens), 0)::bigint AS total_tokens
      ${bucketColumn}
    FROM ${TABLE}
    WHERE "startTime" >= $1::timestamp
      AND "startTime" < ($2::date + INTERVAL '1 day')
      ${axisFilter}
    GROUP BY 1${bucketGroup}
    `,
    params
  )
  return r.rows
}

/** Retention: delete rows started before `cutoff`. Returns how many. */
export async function deleteSpendLogsBefore(_by: SystemActor, cutoff: Date): Promise<number> {
  const r = await useLitellmPool().query(`DELETE FROM ${TABLE} WHERE "startTime" < $1`, [cutoff.toISOString()])
  return r.rowCount ?? 0
}

/**
 * Distinct user ids (`user:<id>` tags) with a logged call between two dates
 * (`to` inclusive), for the admin's "people using AI". Spend and requests
 * come from `spendByFeature`; a user count cannot be summed from its groups.
 * The logs keep the calls of accounts deleted since, so the caller matches
 * the ids against the accounts that still exist (`countExistingUsers`).
 */
export async function listSpendUserIds(_by: AdminActor, window: { from: string, to: string }): Promise<number[]> {
  const r = await useLitellmPool().query<{ id: string }>(
    `
    SELECT DISTINCT substring(t.tag FROM 6) AS id
    FROM ${TABLE},
      jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(request_tags) = 'array' THEN request_tags ELSE '[]'::jsonb END
      ) AS t(tag)
    WHERE "startTime" >= $1::timestamp
      AND "startTime" < ($2::date + INTERVAL '1 day')
      AND t.tag ~ '^user:[0-9]{1,15}$'
    `,
    [window.from, window.to]
  )
  return r.rows.map(row => Number(row.id)).filter(id => Number.isSafeInteger(id))
}

export interface DailySpendRow {
  day: string
  feature: string
  model: string
  platformPaid: boolean
  spendUsd: number
  requests: number
  users: number
}

/**
 * Per UTC day, feature tag ('other' without one) and model between two
 * days (`to` inclusive): cost, requests and distinct `user:*` tags. Input
 * of the identifier-free rollup (`ai-spend-rollup`). A call on a user's
 * own key goes through the `byok/*` deployment and is not platform-paid.
 */
export async function dailySpendForRollup(_by: SystemActor, window: { from: string, to: string }): Promise<DailySpendRow[]> {
  const tag = (prefix: string) => `(
      SELECT min(t.tag)
      FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(request_tags) = 'array' THEN request_tags ELSE '[]'::jsonb END
      ) AS t(tag)
      WHERE t.tag LIKE '${prefix}%'
    )`
  const r = await useLitellmPool().query<{ day: string, feature: string, model: string, platform_paid: boolean, spend: number, requests: number, users: number }>(
    `
    SELECT ("startTime")::date::text AS day,
      coalesce(${tag('feature:')}, 'other') AS feature,
      coalesce(model, '') AS model,
      NOT (coalesce(model_group, '') LIKE 'byok/%' OR coalesce(model, '') LIKE 'byok/%') AS platform_paid,
      coalesce(sum(spend), 0)::float8 AS spend,
      count(*)::int AS requests,
      count(DISTINCT ${tag('user:')})::int AS users
    FROM ${TABLE}
    WHERE "startTime" >= $1::timestamp
      AND "startTime" < ($2::date + INTERVAL '1 day')
    GROUP BY 1, 2, 3, 4
    `,
    [window.from, window.to]
  )
  return r.rows.map(row => ({
    day: row.day,
    feature: row.feature,
    model: row.model,
    platformPaid: row.platform_paid,
    spendUsd: Number(row.spend),
    requests: Number(row.requests),
    users: Number(row.users)
  }))
}
