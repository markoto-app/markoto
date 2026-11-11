import { apiError } from '../api/apiError'
import { getWorkspaceSubscription, listSubscriptionsForWorkspaces, subscriptionGrantsPlan, type WorkspaceSubscriptionRow } from '../../repos/workspaceSubscriptions'
import { countMembers } from '../../repos/workspaceMembers'
import { countOpenWorkspaceInvites } from '../../repos/workspaceInvites'
import { getTiers } from './tierConfig'
import { isBillingEnabled } from './billingMode'
import type { WorkspacePlanName } from '~~/shared/config/tiers'
import { MAX_WORKSPACE_SEATS, MIN_WORKSPACE_SEATS } from '~~/shared/config/workspaceSeats'
import { DAY_MS } from '~~/shared/config/units'

// Team / Business workspace billing.
//
// A workspace with an ENTITLED subscription (billing on, status active /
// trialing / past_due, not expired — `subscriptionGrantsPlan`) is
// "pooled":
//   - its AI budget is one LiteLLM team per workspace with
//     seats × the plan's per-seat `litellmBudgetUsd`, and each member AI
//     call inside it runs on that member's own key in the team
//     (`litellm/workspaceTeams.ts`, `billing.ts`);
//   - its knowledge + image storage is one pool of seats × the plan's
//     per-seat `knowledgeFiles` / `knowledgeBytesPerWorkspace` /
//     `imageBytesPerUser` (the Team / Business values of those tier
//     fields are PER SEAT), and uploads into it don't count against the
//     uploader's personal storage;
//   - members + open invitations may not exceed the paid seats.
// Everything else (personal documents, other workspaces) keeps the
// per-user rules.

export { MIN_WORKSPACE_SEATS, MAX_WORKSPACE_SEATS } from '~~/shared/config/workspaceSeats'
/** A member's default AI limit = this many seats' worth of the pooled budget. */
const DEFAULT_MEMBER_LIMIT_SEAT_SHARES = 2

export interface PooledWorkspace {
  workspaceId: string
  plan: WorkspacePlanName
  seats: number
  subscription: WorkspaceSubscriptionRow
}

/** The workspace's entitled Team / Business subscription, else null. */
export async function getPooledWorkspace(workspaceId: string | null | undefined, now: Date = new Date()): Promise<PooledWorkspace | null> {
  if (!workspaceId || !isBillingEnabled()) return null
  const sub = await getWorkspaceSubscription(workspaceId)
  return sub ? pooledFromRow(sub, now) : null
}

/** Pure: a subscription row as a pooled workspace when it grants its plan. */
export function pooledFromRow(sub: WorkspaceSubscriptionRow, now: Date = new Date()): PooledWorkspace | null {
  if (!subscriptionGrantsPlan(sub, now)) return null
  return { workspaceId: sub.workspaceId, plan: sub.plan, seats: Math.max(1, sub.seats), subscription: sub }
}

export interface WorkspacePoolCaps {
  /** Monthly AI budget of the whole workspace, USD. */
  aiBudgetUsd: number
  /** Default member limit, USD (2 × per-seat budget). */
  defaultMemberLimitUsd: number
  knowledgeFiles: number
  knowledgeBytes: number
  imageBytes: number
}

/** Pure: pooled limits for a plan + seat count. */
export function workspacePoolCaps(plan: WorkspacePlanName, seats: number, tiers = getTiers()): WorkspacePoolCaps {
  const perSeat = tiers[plan]
  const n = Math.max(1, seats)
  return {
    aiBudgetUsd: roundUsd(perSeat.litellmBudgetUsd * n),
    defaultMemberLimitUsd: roundUsd(perSeat.litellmBudgetUsd * DEFAULT_MEMBER_LIMIT_SEAT_SHARES),
    knowledgeFiles: perSeat.knowledgeFiles * n,
    knowledgeBytes: perSeat.knowledgeBytesPerWorkspace * n,
    imageBytes: perSeat.imageBytesPerUser * n
  }
}

/** LiteLLM's budget window of a workspace team (`budget_duration: 30d`). */
const WORKSPACE_BUDGET_WINDOW_MS = 30 * DAY_MS

type BudgetSeatFields = Pick<WorkspaceSubscriptionRow, 'seats' | 'budgetSeatAdjust' | 'budgetSeatAdjustUntil'>

/**
 * Pure: the seats the pooled AI budget counts right now — the paid seats,
 * adjusted for seat changes inside the current budget window until that
 * window ends (`changedSeatBudgetAdjust`).
 */
export function budgetSeats(sub: BudgetSeatFields, now: Date = new Date()): number {
  const seats = Math.max(1, sub.seats)
  if (!sub.budgetSeatAdjustUntil || sub.budgetSeatAdjustUntil.getTime() <= now.getTime()) return seats
  return Math.max(0, seats + sub.budgetSeatAdjust)
}

/** The workspace's pooled AI budget for the current window, USD (without credits). */
export function workspaceAiBudgetUsd(pool: PooledWorkspace, now: Date = new Date(), tiers = getTiers()): number {
  return roundUsd(tiers[pool.plan].litellmBudgetUsd * budgetSeats({ ...pool.subscription, seats: pool.seats }, now))
}

/**
 * Pure: the budget-seat adjustment after the paid seats change from
 * `from` to `to` while the LiteLLM budget window runs until `windowEnd`.
 *
 * - More seats are charged pro rata (`always_invoice`), so each added
 *   seat unlocks only the share of a seat's budget for the days left in
 *   the window: adjust −= added × (1 − left).
 * - Fewer seats are not credited (`proration_behavior: 'none'`), so the
 *   removed seats keep their budget until the window ends:
 *   adjust += removed.
 *
 * With no window (no LiteLLM team yet, or it already ended) the next
 * window starts fresh and counts the paid seats: no adjustment.
 */
export function changedSeatBudgetAdjust(args: {
  current: Pick<WorkspaceSubscriptionRow, 'budgetSeatAdjust' | 'budgetSeatAdjustUntil'>
  from: number
  to: number
  windowEnd: Date | null
  now?: Date
}): { adjust: number, until: Date | null } {
  const now = args.now ?? new Date()
  if (!args.windowEnd || args.windowEnd.getTime() <= now.getTime()) return { adjust: 0, until: null }
  const until = args.current.budgetSeatAdjustUntil
  const prior = until && until.getTime() > now.getTime() ? args.current.budgetSeatAdjust : 0
  const delta = args.to - args.from
  const left = Math.min(1, Math.max(0, (args.windowEnd.getTime() - now.getTime()) / WORKSPACE_BUDGET_WINDOW_MS))
  const adjust = delta > 0 ? prior - delta * (1 - left) : prior - delta
  return { adjust: Math.round(adjust * 10_000) / 10_000, until: args.windowEnd }
}

/**
 * Pure: a member's effective AI limit in USD, `null` = no member limit
 * (the team budget still applies).
 */
export function memberLimitUsd(member: { aiLimitUsd: number | null, aiUnlimited: boolean }, caps: WorkspacePoolCaps): number | null {
  if (member.aiUnlimited) return null
  return member.aiLimitUsd ?? caps.defaultMemberLimitUsd
}

/** Seats in use: members + open invitations. */
export async function countSeatsUsed(workspaceId: string, now: Date = new Date(), exceptInviteEmail?: string): Promise<number> {
  const [members, invites] = await Promise.all([
    countMembers(workspaceId),
    // Guests and their invitations take no seat.
    countOpenWorkspaceInvites(workspaceId, now, exceptInviteEmail, 'members')
  ])
  return members + invites
}

/** Validate a requested seat count (400 on garbage). */
export function parseSeats(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(n) || n < MIN_WORKSPACE_SEATS || n > MAX_WORKSPACE_SEATS) {
    throw apiError('billing/invalid-seats', { min: MIN_WORKSPACE_SEATS, max: MAX_WORKSPACE_SEATS })
  }
  return n
}

/** 409 when the paid seats are all taken (members + open invitations). */
export function seatsFullError(seats: number, used: number) {
  return createError({
    statusCode: 409,
    message: `All ${seats} paid seats are taken. Add a seat to invite someone else.`,
    data: { code: 'billing/seats-full', messageKey: 'workspace.billing.errors.seatsFull', seats, used }
  })
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Which of these workspaces a Team / Business subscription covers right
 * now (billing on only): workspace id → plan. For badges and hints.
 */
export async function pooledPlansFor(workspaceIds: readonly string[], now: Date = new Date()): Promise<Map<string, WorkspacePlanName>> {
  const out = new Map<string, WorkspacePlanName>()
  if (!isBillingEnabled() || workspaceIds.length === 0) return out
  const rows = await listSubscriptionsForWorkspaces(workspaceIds)
  for (const row of rows) {
    const pool = pooledFromRow(row, now)
    if (pool) out.set(row.workspaceId, pool.plan)
  }
  return out
}
