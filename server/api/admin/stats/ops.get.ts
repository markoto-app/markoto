import { adminStatsQuery } from '~~/shared/api/legal'
import { buildOpsStats, resolveStatsWindow } from '../../../utils/adminStats/productStats'
import { cachedAdminStats } from '../../../utils/adminStats/statsCache'

// Admin product stats, ops tab. Aggregates only; definitions in
// docs/contributing/admin-metrics.md.
export default defineApiHandler({
  access: allow.admin(),
  query: adminStatsQuery,
  handler: ({ query, adminActor }) => cachedAdminStats(`ops:${query.range}:${query.bucket ?? ''}`, async () =>
    buildOpsStats(adminActor, await resolveStatsWindow(adminActor, query.range, query.bucket)))
})
