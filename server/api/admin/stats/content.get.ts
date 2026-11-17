import { adminStatsQuery } from '~~/shared/api/legal'
import { buildContentStats, resolveStatsWindow } from '../../../utils/adminStats/productStats'
import { cachedAdminStats } from '../../../utils/adminStats/statsCache'

// Admin product stats, content tab. Aggregates only; definitions in
// docs/contributing/admin-metrics.md.
export default defineApiHandler({
  access: allow.admin(),
  query: adminStatsQuery,
  handler: ({ query, adminActor }) => cachedAdminStats(`content:${query.range}:${query.bucket ?? ''}`, async () =>
    buildContentStats(adminActor, await resolveStatsWindow(adminActor, query.range, query.bucket)))
})
