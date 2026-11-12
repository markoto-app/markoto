import { clearSeatAdjustment, listAllWorkspaceSubscriptions } from '../../repos/workspaceSubscriptions'
import { system } from '../../repos/proofs'
import { isBillingEnabled } from './billingMode'
import { getPooledWorkspace, pooledFromRow, type PooledWorkspace } from './workspaceBilling'
import { ensureWorkspaceTeam, readWorkspaceTeam } from '../litellm/workspaceTeams'
import { notifyWorkspaceAdmins } from '../email/workspaceBillingEmails'
import { useLogger } from '../platform/logger'

/** The budget-alert job reads and adjusts every workspace's subscription row. */
const ALERTS = system('workspace-billing')

const log = useLogger('workspace-budget')

// Budget alerts for Team / Business workspaces: when a workspace's
// pooled AI budget reaches 80 % and 100 % of the month, its admins get
// one email each (once per level per budget period — the once-key holds
// LiteLLM's `budget_reset_at`). Run by `plugins/workspace-budget-alerts.ts`
// every 15 minutes; LiteLLM is the source of the spend. The same run ends
// expired seat-change budget adjustments (`endSeatAdjustment`).

const BUDGET_ALERT_LEVELS = [1, 0.8] as const

/** Pure: the highest alert level a spend has reached, or null. */
export function budgetAlertLevel(spend: number, budget: number): 0.8 | 1 | null {
  if (Number.isNaN(budget) || budget <= 0) return null
  for (const level of BUDGET_ALERT_LEVELS) {
    if (spend >= budget * level) return level
  }
  return null
}

/**
 * A seat change's budget adjustment ends with its LiteLLM budget window
 * (`workspaceBilling.ts#changedSeatBudgetAdjust`). Clear it and push the
 * plain seats × per-seat budget into the new window, so prorated seats
 * get their full budget (and removed seats lose theirs) within one run.
 */
async function endSeatAdjustment(pool: PooledWorkspace, now: Date): Promise<void> {
  const until = pool.subscription.budgetSeatAdjustUntil
  if (!until || until.getTime() > now.getTime()) return
  await clearSeatAdjustment(ALERTS, pool.workspaceId, until)
  const fresh = await getPooledWorkspace(pool.workspaceId, now)
  if (fresh) {
    await ensureWorkspaceTeam(fresh).catch((e: unknown) => {
      log.warn('budget update failed', { workspaceId: pool.workspaceId, err: e })
    })
  }
}

export async function runWorkspaceBudgetAlerts(now: Date = new Date()): Promise<{ checked: number, alerted: number }> {
  if (!isBillingEnabled()) return { checked: 0, alerted: 0 }
  let checked = 0
  let alerted = 0
  const rows = await listAllWorkspaceSubscriptions(ALERTS)
  for (const row of rows) {
    const pool = pooledFromRow(row, now)
    if (!pool) continue
    checked++
    await endSeatAdjustment(pool, now)
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
    if (sent > 0) alerted++
  }
  return { checked, alerted }
}
