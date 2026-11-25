import { useUmamiPool } from '../db/umami'
import type { AdminActor } from './proofs'

// Landing visits from Umami's database (docs/SELF-HOSTING.md#analytics-optional),
// for the admin's "Funnel by source". One row per landing query and
// referring domain with the number of visits that started with it; the
// caller turns them into acquisition sources. Read-only.

export interface LandingVisitRow {
  /** The landing URL's query without `?` (only the UTM parameters and `ref` are ever sent). */
  query: string | null
  referrerDomain: string | null
  visits: number
}

/** Visits (Umami `visit_id`) of the website whose first page view falls in `[from, to)` (UTC days). */
export async function landingVisits(_by: AdminActor, websiteId: string, from: string, to: string): Promise<LandingVisitRow[]> {
  // A visit that started just before the window is not counted in it, so
  // the scan reaches one day further back to find its first page view.
  const res = await useUmamiPool().query<{ query: string | null, referrer_domain: string | null, visits: number }>(`
    SELECT url_query AS query, referrer_domain, count(*)::int AS visits
    FROM (
      SELECT DISTINCT ON (visit_id) url_query, referrer_domain, created_at
      FROM website_event
      WHERE website_id = $1::uuid AND event_type = 1
        AND created_at >= ($2::timestamp AT TIME ZONE 'UTC') - interval '1 day'
        AND created_at < ($3::timestamp AT TIME ZONE 'UTC')
      ORDER BY visit_id, created_at
    ) v
    WHERE created_at >= ($2::timestamp AT TIME ZONE 'UTC')
    GROUP BY 1, 2`, [websiteId, from, to])
  return res.rows.map(r => ({ query: r.query, referrerDomain: r.referrer_domain, visits: Number(r.visits) }))
}
