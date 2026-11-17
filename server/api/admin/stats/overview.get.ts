import { adminStatsQuery } from '~~/shared/api/legal'
import { buildOverviewStats, resolveStatsWindow } from '../../../utils/adminStats/productStats'
import { cachedAdminStats } from '../../../utils/adminStats/statsCache'

// Admin product stats, overview tab. Aggregates only; definitions in
// docs/contributing/admin-metrics.md.
export default defineApiHandler({
  access: allow.admin(),
  query: adminStatsQuery,
  handler: ({ query, adminActor }) => cachedAdminStats(`overview:${query.range}:${query.bucket ?? ''}`, async () =>
    buildOverviewStats(adminActor, await resolveStatsWindow(adminActor, query.range, query.bucket)))
})
