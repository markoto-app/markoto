import { adminStatsQuery } from '~~/shared/api/legal'
import { buildUsersStats, resolveStatsWindow } from '../../../utils/adminStats/productStats'
import { cachedAdminStats } from '../../../utils/adminStats/statsCache'

// Admin product stats, users tab. Aggregates only; definitions in
// docs/contributing/admin-metrics.md.
export default defineApiHandler({
  access: allow.admin(),
  query: adminStatsQuery,
  handler: ({ query, adminActor }) => cachedAdminStats(`users:${query.range}:${query.bucket ?? ''}`, async () =>
    buildUsersStats(adminActor, await resolveStatsWindow(adminActor, query.range, query.bucket)))
})
