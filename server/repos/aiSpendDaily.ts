import { sql } from 'drizzle-orm'
import { aiSpendDaily } from '../db/schema'
import { useDatabase } from '../db/client'
import type { AdminActor, SystemActor } from './proofs'
import type { DailySpendRow } from './litellmSpend'

// The identifier-free daily AI cost rollup (`ai_spend_daily`), written by
// `ai-spend-rollup` from LiteLLM's spend logs and read by the admin's AI
// stats for the days the raw logs no longer cover.

/** Write (or overwrite) the rollup rows of the given days. */
export async function upsertAiSpendDaily(_by: SystemActor, rows: readonly DailySpendRow[]): Promise<number> {
  if (rows.length === 0) return 0
  await useDatabase().insert(aiSpendDaily).values(rows.map(r => ({
    day: r.day,
    feature: r.feature,
    model: r.model,
    platformPaid: r.platformPaid,
    spendUsd: r.spendUsd,
    requests: r.requests,
    users: r.users
  }))).onConflictDoUpdate({
    target: [aiSpendDaily.day, aiSpendDaily.feature, aiSpendDaily.model, aiSpendDaily.platformPaid],
    set: {
      spendUsd: sql`excluded.spend_usd`,
      requests: sql`excluded.requests`,
      users: sql`excluded.users`,
      updatedAt: sql`now()`
    }
  })
  return rows.length
}

/** First day the rollup holds, null when it is empty. */
export async function earliestAiSpendDay(_by: AdminActor): Promise<string | null> {
  const r = (await useDatabase().execute<{ day: string | null }>(sql`SELECT min(day)::text AS day FROM ai_spend_daily`)).rows[0]
  return r?.day ?? null
}

/** Cost and requests per time bucket and feature in [from, to) (days). */
export async function aiSpendDailyByBucket(_by: AdminActor, from: string, to: string, bucket: 'day' | 'week' | 'month'): Promise<Array<{ t: string, feature: string, spend: number, requests: number }>> {
  const rows = (await useDatabase().execute<{ t: string, feature: string, spend: number, requests: number }>(sql`
    SELECT date_trunc(${bucket}, day)::date::text AS t, feature,
      sum(spend_usd)::float8 AS spend, sum(requests)::int AS requests
    FROM ai_spend_daily
    WHERE day >= ${from}::date AND day < ${to}::date
    GROUP BY 1, 2 ORDER BY 1, 2`)).rows
  return rows.map(r => ({ t: r.t, feature: r.feature, spend: Number(r.spend), requests: Number(r.requests) }))
}
