import { adminStatsQuery } from '~~/shared/api/legal'
import { buildAiStats, buildUsersStats, resolveStatsWindow } from '../../../utils/adminStats/productStats'
import { cachedAdminStats } from '../../../utils/adminStats/statsCache'

// Admin product stats, AI tab: spend from LiteLLM's spend logs (one count
// per request), bring-your-own-key and MCP use. Aggregates only;
// definitions in docs/contributing/admin-metrics.md.
export default defineApiHandler({
  access: allow.admin(),
  query: adminStatsQuery,
  handler: ({ query, adminActor }) => cachedAdminStats(`ai:${query.range}:${query.bucket ?? ''}`, async () => {
    const w = await resolveStatsWindow(adminActor, query.range, query.bucket)
    const users = await cachedAdminStats(`users:${query.range}:${query.bucket ?? ''}`, () => buildUsersStats(adminActor, w))
    return buildAiStats(adminActor, w, users.active.inWindow)
  })
})
