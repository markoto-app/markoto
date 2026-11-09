import { workspaceSubscriptions } from '../db/schema'
import { useDatabase } from './database'
import { isBillingEnabled } from './billingMode'
import { pooledFromRow } from './workspaceBilling'
import { readWorkspaceTeam } from './litellm/workspaceTeams'
import { notifyWorkspaceAdmins } from './email/workspaceBillingEmails'

// Budget alerts for Team / Business workspaces (WP3): when a workspace's
// pooled AI budget reaches 80 % and 100 % of the month, its admins get
// one email each (once per level per budget period — the once-key holds
// LiteLLM's `budget_reset_at`). Run by `plugins/workspace-budget-alerts.ts`
// every 15 minutes; LiteLLM is the source of the spend.

export const BUDGET_ALERT_LEVELS = [1, 0.8] as const

/** Pure: the highest alert level a spend has reached, or null. */
export function budgetAlertLevel(spend: number, budget: number): 0.8 | 1 | null {
  if (!(budget > 0)) return null
  for (const level of BUDGET_ALERT_LEVELS) {
    if (spend >= budget * level) return level
  }
  return null
}

export async function runWorkspaceBudgetAlerts(now: Date = new Date()): Promise<{ checked: number, alerted: number }> {
  const summary = { checked: 0, alerted: 0 }
  if (!isBillingEnabled()) return summary
  const rows = await useDatabase().select().from(workspaceSubscriptions)
  for (const row of rows) {
    const pool = pooledFromRow(row, now)
    if (!pool) continue
    summary.checked++
    const team = await readWorkspaceTeam(pool.workspaceId).catch(() => null)
    if (!team || typeof team.spend !== 'number' || typeof team.max_budget !== 'number') continue
    const level = budgetAlertLevel(team.spend, team.max_budget)
    if (level === null) continue
    const period = team.budget_reset_at ?? 'none'
    const sent = await notifyWorkspaceAdmins({
      workspaceId: pool.workspaceId,
      kind: level === 1 ? 'budget_100' : 'budget_80',
      date: team.budget_reset_at ? new Date(team.budget_reset_at) : null,
      onceKey: `budget:${pool.workspaceId}:${period}:${level}`
    })
    if (sent > 0) summary.alerted++
  }
  return summary
}
