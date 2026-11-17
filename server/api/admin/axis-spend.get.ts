import { spendByFeature } from '../../repos/litellmSpend'
import { buildSpendBreakdown } from '../../utils/litellm/spendBreakdown'
import { DAY_MS } from '~~/shared/config/units'
import { axisSpendQuery } from '~~/shared/api/legal'

// Spend breakdown by feature for ONE entity of one axis (workspace, user or
// doc); drives the operator dashboard's drill-down. Same query and shape as
// `/api/admin/ai-spend`, filtered to the calls carrying the axis tag, so one
// dashboard component renders both and every call counts once.

function defaultRange(): { from: string, to: string } {
  const today = new Date()
  const past = new Date(today.getTime() - 30 * DAY_MS)
  return {
    from: past.toISOString().slice(0, 10),
    to: today.toISOString().slice(0, 10)
  }
}

export default defineApiHandler({
  access: allow.admin(),
  query: axisSpendQuery,
  handler: async ({ query, adminActor }) => {
    const from = query.from ?? defaultRange().from
    const to = query.to ?? defaultRange().to
    const rows = await spendByFeature(adminActor, { from, to, axisTag: `${query.axis}:${query.value}` })
    return { axis: query.axis, value: query.value, from, to, ...buildSpendBreakdown(rows) }
  }
})
