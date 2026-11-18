import { resolveBillingContext } from '../../billing/billing'
import { getUserKeyInfo } from '../../litellm/userKeys'
import { getFreeTierPoolStatus } from '../../litellm/freeTierTeam'
import { readMemberKeySpend, readWorkspaceTeam } from '../../litellm/workspaceTeams'
import { useLogger } from '../../platform/logger'

const log = useLogger('ai-jobs')

// What is left of the AI budget a delegated job would draw on, read the
// way `GET /api/ai/credits` reads it: the user's key (`/key/info`:
// max_budget - spend), the shared free-tier pool (used up = nothing left),
// or a Team / Business workspace's member limit and team pool (the
// smaller of the two). The estimate is compared with it before a job
// starts (`estimate.ts`: `needsConfirmation`, `exceedsBudget`).
// Null = unknown: the proxy can't be read, or the job runs on the user's
// own key (BYOK spends nothing of the platform budget). Fail open: the
// proxy's `max_budget` is the real gate and pauses the job anyway.

export interface BudgetTarget {
  initiatorUserId: number
  workspaceId: string | null
}

export async function remainingBudgetUsd(target: BudgetTarget): Promise<number | null> {
  try {
    const billing = await resolveBillingContext(target.initiatorUserId, target.workspaceId)
    if (billing.attribution === 'workspace' && billing.workspaceId) {
      const [member, team] = await Promise.all([
        readMemberKeySpend(billing.virtualKey),
        readWorkspaceTeam(billing.workspaceId).catch(() => null)
      ])
      const teamLeft = typeof team?.max_budget === 'number' ? Math.max(0, team.max_budget - (team.spend ?? 0)) : null
      const memberLeft = member?.maxBudget != null ? Math.max(0, member.maxBudget - member.spend) : null
      if (teamLeft === null) return memberLeft
      return memberLeft === null ? teamLeft : Math.min(teamLeft, memberLeft)
    }
    const pool = await getFreeTierPoolStatus()
    if (pool?.exhausted) return 0
    const info = await getUserKeyInfo(billing.billingUserId, billing.plan)
    return Math.max(0, info.maxBudget - info.spend)
  } catch (e) {
    log.warn('could not read the remaining AI budget', { err: e })
    return null
  }
}
