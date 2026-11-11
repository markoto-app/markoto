import { and, asc, eq, ne } from 'drizzle-orm'
import { users, workspaceMembers } from '../../../../db/schema'
import { useDatabase } from '../../../../utils/platform/database'
import { getWorkspaceSubscription, subscriptionGrantsPlan } from '../../../../repos/workspaceSubscriptions'
import { isBillingEnabled } from '../../../../utils/billing/billingMode'
import { creditBalanceView } from '../../../../utils/billing/aiCreditBudget'
import { decryptToken } from '../../../../utils/litellm/tokenCrypto'
import { readMemberKeySpend, readWorkspaceTeam } from '../../../../utils/litellm/workspaceTeams'
import {
  countSeatsUsed,
  memberLimitUsd,
  requireWorkspaceBillingAdmin,
  workspacePoolCaps,
  MIN_WORKSPACE_SEATS
} from '../../../../utils/billing/workspaceBilling'

// GET /api/workspaces/:wsId/billing — the workspace billing tab.
// Workspace admins only (404 non-member, 403 member).
//
// Always answers (also with billing off, so the tab can explain itself):
//   billingEnabled, subscription (null = never bought), seats used,
//   whether the caller is the billing admin, the pooled limits and —
//   while the subscription is entitled — the AI spend of the team and of
//   every member (live from LiteLLM, best-effort: null when unreadable).
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const wsId = requireWsId(event)
  await requireWorkspaceBillingAdmin(session.user.id, wsId)

  const billingEnabled = isBillingEnabled()
  const sub = await getWorkspaceSubscription(wsId)
  const entitled = billingEnabled && sub !== null && subscriptionGrantsPlan(sub)
  const seatsUsed = await countSeatsUsed(wsId)

  const rows = await useDatabase()
    .select({
      userId: users.id,
      name: users.name,
      role: workspaceMembers.role,
      aiLimitUsd: workspaceMembers.aiLimitUsd,
      aiUnlimited: workspaceMembers.aiUnlimited,
      keyToken: workspaceMembers.litellmKeyToken
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    // Guests take no seat and never use the workspace's AI budget.
    .where(and(eq(workspaceMembers.workspaceId, wsId), ne(workspaceMembers.role, 'guest')))
    .orderBy(asc(workspaceMembers.joinedAt))

  const caps = sub ? workspacePoolCaps(sub.plan, sub.seats) : null
  const team = entitled ? await readWorkspaceTeam(wsId).catch(() => null) : null
  const members = await Promise.all(rows.map(async (row) => {
    let spendUsd: number | null = null
    if (entitled && row.keyToken) {
      try {
        spendUsd = (await readMemberKeySpend(decryptToken(row.keyToken)))?.spend ?? null
      } catch {
        spendUsd = null
      }
    } else if (entitled) {
      spendUsd = 0
    }
    return {
      userId: row.userId,
      name: row.name,
      role: row.role,
      limitUsd: caps ? memberLimitUsd(row, caps) : null,
      limitIsDefault: row.aiLimitUsd === null && !row.aiUnlimited,
      unlimited: row.aiUnlimited,
      spendUsd
    }
  }))

  return {
    billingEnabled,
    minSeats: MIN_WORKSPACE_SEATS,
    seatsUsed,
    isBillingAdmin: sub?.billingAdminId === session.user.id,
    subscription: sub
      ? {
          plan: sub.plan,
          seats: sub.seats,
          status: sub.status,
          entitled,
          interval: sub.interval,
          currency: sub.currency,
          currentPeriodStart: sub.currentPeriodStart?.toISOString() ?? null,
          validUntil: sub.validUntil?.toISOString() ?? null,
          billingAdminId: sub.billingAdminId
        }
      : null,
    pool: caps
      ? {
          aiBudgetUsd: typeof team?.max_budget === 'number' ? team.max_budget : caps.aiBudgetUsd,
          aiSpendUsd: entitled ? (typeof team?.spend === 'number' ? team.spend : 0) : null,
          defaultMemberLimitUsd: caps.defaultMemberLimitUsd,
          knowledgeBytes: caps.knowledgeBytes,
          imageBytes: caps.imageBytes,
          resetsAt: team?.budget_reset_at ?? null
        }
      : null,
    members,
    // AI credit top-ups.
    credits: billingEnabled ? await creditBalanceView({ type: 'workspace', id: wsId }) : null
  }
})
