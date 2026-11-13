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

export interface FeatureSpendRow { feature_tag: string, spend: string, requests: string, total_tokens: string }

/**
 * Spend per `feature:*` tag of the calls carrying `axisTag` (e.g.
 * `workspace:<id>`) between two dates (`to` inclusive). `?` tests JSONB
 * array membership; the `startTime` bound keeps it off all-time scans.
 */
export async function spendByFeatureForTag(_by: AdminActor, axisTag: string, from: string, to: string): Promise<FeatureSpendRow[]> {
  const r = await useLitellmPool().query<FeatureSpendRow>(
    `
    WITH matched AS (
      SELECT spend, total_tokens, request_tags AS tags
      FROM ${TABLE}
      WHERE "startTime" >= $2::timestamp
        AND "startTime" < ($3::date + INTERVAL '1 day')
        AND request_tags ? $1
    ),
    feature_rows AS (
      -- Unnest the tags; only feature-prefixed entries are kept below, so
      -- the sibling axes (workspace, user, doc) drop out.
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
    [axisTag, from, to]
  )
  return r.rows
}

/** Retention: delete rows started before `cutoff`. Returns how many. */
export async function deleteSpendLogsBefore(_by: SystemActor, cutoff: Date): Promise<number> {
  const r = await useLitellmPool().query(`DELETE FROM ${TABLE} WHERE "startTime" < $1`, [cutoff.toISOString()])
  return r.rowCount ?? 0
}
