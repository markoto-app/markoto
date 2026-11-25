import { adminStatsQuery } from '~~/shared/api/legal'
import { resolveStatsWindow } from '../../../utils/adminStats/productStats'
import { buildFunnelStats } from '../../../utils/adminStats/funnelStats'
import { cachedAdminStats } from '../../../utils/adminStats/statsCache'

// Admin product stats, funnel tab: visits, first documents, sign-ups,
// checkouts and paid accounts per acquisition source. Counts only;
// definitions in docs/contributing/admin-metrics.md#funnel-by-source.
export default defineApiHandler({
  access: allow.admin(),
  query: adminStatsQuery,
  handler: ({ query, adminActor }) => cachedAdminStats(`funnel:${query.range}`, async () =>
    buildFunnelStats(adminActor, await resolveStatsWindow(adminActor, query.range, query.bucket)))
})
