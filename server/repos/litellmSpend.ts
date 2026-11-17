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
 * Distinct users (`user:*` tag) with a logged call between two dates (`to`
 * inclusive), for the admin's "people using AI". Spend and requests come
 * from `spendByFeature`; a user count cannot be summed from its groups.
 */
export async function countSpendUsers(_by: AdminActor, window: { from: string, to: string }): Promise<number> {
  const r = await useLitellmPool().query<{ users: number }>(
    `
    SELECT count(DISTINCT (
      SELECT min(t.tag)
      FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(request_tags) = 'array' THEN request_tags ELSE '[]'::jsonb END
      ) AS t(tag)
      WHERE t.tag LIKE 'user:%'
    ))::int AS users
    FROM ${TABLE}
    WHERE "startTime" >= $1::timestamp
      AND "startTime" < ($2::date + INTERVAL '1 day')
    `,
    [window.from, window.to]
  )
  return Number(r.rows[0]?.users ?? 0)
}
