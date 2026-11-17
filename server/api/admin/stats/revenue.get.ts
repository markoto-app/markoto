import { adminStatsQuery } from '~~/shared/api/legal'
import { buildRevenueStats, resolveStatsWindow } from '../../../utils/adminStats/productStats'
import { cachedAdminStats } from '../../../utils/adminStats/statsCache'

// Admin product stats, revenue tab. Aggregates only; definitions in
// docs/contributing/admin-metrics.md.
export default defineApiHandler({
  access: allow.admin(),
  query: adminStatsQuery,
  handler: ({ query, adminActor }) => cachedAdminStats(`revenue:${query.range}:${query.bucket ?? ''}`, async () =>
    buildRevenueStats(adminActor, await resolveStatsWindow(adminActor, query.range, query.bucket)))
})
