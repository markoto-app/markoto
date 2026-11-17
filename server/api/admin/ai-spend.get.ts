import { spendByFeature } from '../../repos/litellmSpend'
import { buildSpendBreakdown } from '../../utils/litellm/spendBreakdown'
import { DAY_MS } from '~~/shared/config/units'
import { aiSpendQuery } from '~~/shared/api/legal'

// Operator dashboard (/admin/ai-spend, admin-gated): per-feature LiteLLM spend
// over a date window, read from `LiteLLM_SpendLogs` (`repos/litellmSpend.ts`).
// Not LiteLLM's `/spend/tags`: that sums per tag, and every call carries
// several (feature, user, doc, workspace and LiteLLM's own User-Agent tags),
// so its totals counted each call several times.
//
// Window defaults to the last 30 days; `?from=YYYY-MM-DD&to=YYYY-MM-DD`
// override it. Invalid dates fall back to the default rather than 400, so a
// typo'd URL still shows a chart.

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
  query: aiSpendQuery,
  handler: async ({ query, adminActor }) => {
    const from = query.from ?? defaultRange().from
    const to = query.to ?? defaultRange().to
    const rows = await spendByFeature(adminActor, { from, to })
    return { from, to, ...buildSpendBreakdown(rows) }
  }
})
