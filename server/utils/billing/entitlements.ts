// Plan entitlements — which plan applies to an action, and what that
// plan allows. One place every plan limit and feature switch goes
// through, so enforcement and the UI can't disagree.
//
// The caps themselves live in `shared/config/tiers.ts` (committed
// self-host defaults + `TIER_<PLAN>_<FIELD>` runtime overrides). With
// billing off (self-host, and the hosted free-only phase) every
// account resolves to `free` through `effectivePlan`, so the free tier
// IS the instance's limits: the committed free tier switches every
// feature on, the hosted deployment narrows it via `TIER_FREE_*`.
//
// Whose plan counts:
//   - Document features (custom CSS, history window): the DOCUMENT's
//     plan — its workspace's plan for a workspace document, else its
//     owner's plan; anonymous documents are `free`.
//   - Workspace limits (members): the WORKSPACE's plan.
//   - Personal limits (saved presets, import size, MCP, web tools):
//     the ACTING user's plan; anonymous callers are `free`.
//
// The workspace plan is its Team / Business subscription
// (`workspace_subscriptions`) or, when better, its creator's personal plan
// (`workspaces.owner_id` — never used for authorisation; here it only
// picks a limit).
//
// Reads `process.env` through `getTiers()` / `effectivePlan()` on every
// call, like `tierConfig.ts`, so repos/unit tests can vary env per case.

import { eq } from 'drizzle-orm'
import { documents, users, workspaces } from '../../db/schema'
import { useDatabase } from '../platform/database'
import { getTiers } from './tierConfig'
import { effectivePlan, isBillingEnabled, limitRecovery, limitUpgradeHint } from './billingMode'
import { getWorkspaceSubscription, subscriptionGrantsPlan } from '../../repos/workspaceSubscriptions'
import { planRank, type FeatureField, type PlanName, type TierCaps } from '~~/shared/config/tiers'
import { PLAN_FEATURE_UNAVAILABLE_CODE, PLAN_LIMIT_REACHED_CODE } from '~~/shared/config/planErrors'

export { PLAN_FEATURE_UNAVAILABLE_CODE, PLAN_LIMIT_REACHED_CODE }

/** The resolved caps of a plan. */
export function capsFor(plan: PlanName): TierCaps {
  return getTiers()[plan]
}

/** Effective plan of a user (`free` for anonymous, unknown, lapsed or billing off). */
export async function resolveUserPlan(userId: number | null | undefined): Promise<PlanName> {
  if (userId === null || userId === undefined) return 'free'
  const row = (await useDatabase()
    .select({ plan: users.plan, planValidUntil: users.planValidUntil })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1))[0]
  return row ? effectivePlan(row.plan, row.planValidUntil) : 'free'
}

/**
 * Effective plan of a workspace: the better of
 *   - its Team / Business subscription, while billing is on and the
 *     subscription grants its plan (`subscriptionGrantsPlan`), and
 *   - its creator's personal plan — a Pro user's own small workspaces get
 *     Pro features without a workspace subscription.
 */
export async function resolveWorkspacePlan(workspaceId: string): Promise<PlanName> {
  const [row, subscription] = await Promise.all([
    useDatabase()
      .select({ ownerId: workspaces.ownerId })
      .from(workspaces)
      .where(eq(workspaces.workspaceId, workspaceId))
      .limit(1)
      .then(rows => rows[0]),
    getWorkspaceSubscription(workspaceId)
  ])
  if (!row) return 'free'
  const creatorPlan = await resolveUserPlan(row.ownerId)
  const subscriptionPlan: PlanName | null = isBillingEnabled() && subscription && subscriptionGrantsPlan(subscription)
    ? subscription.plan
    : null
  return subscriptionPlan !== null && planRank(subscriptionPlan) > planRank(creatorPlan) ? subscriptionPlan : creatorPlan
}

/** Effective plan of a document, from its row fields. */
export async function resolveDocPlanFor(doc: { ownerId: number | null, workspaceId: string | null }): Promise<PlanName> {
  if (doc.workspaceId) return resolveWorkspacePlan(doc.workspaceId)
  return resolveUserPlan(doc.ownerId)
}

/** Effective plan of a document by id (`free` when it doesn't exist). */
export async function resolveDocPlan(docId: string): Promise<PlanName> {
  const row = (await useDatabase()
    .select({ ownerId: documents.ownerId, workspaceId: documents.workspaceId })
    .from(documents)
    .where(eq(documents.docId, docId))
    .limit(1))[0]
  return row ? resolveDocPlanFor(row) : 'free'
}

/** Whether a plan includes a feature switch. */
export function planHasFeature(plan: PlanName, feature: FeatureField): boolean {
  return capsFor(plan)[feature]
}

/**
 * Refuse an action the plan doesn't include. 409 like every other cap
 * in the codebase (`workspace/cap-reached`, `upload/storage-quota`),
 * with a stable code, the feature name and a mode-aware recovery link.
 */
export function assertPlanFeature(plan: PlanName, feature: FeatureField, message: string): void {
  if (planHasFeature(plan, feature)) return
  throw createError({
    statusCode: 409,
    message: `${message} ${limitUpgradeHint()}`,
    data: {
      code: PLAN_FEATURE_UNAVAILABLE_CODE,
      feature,
      plan,
      messageKey: `plan.feature.${feature}`,
      recovery: limitRecovery()
    }
  })
}

/** Refuse when `used` already fills a numeric cap (`null` = no limit). */
export function assertPlanLimit(
  plan: PlanName,
  field: 'membersPerWorkspace' | 'savedThemes' | 'mcpToolCallsPerDay' | 'webToolsPerDay',
  used: number,
  message: string
): void {
  const limit = capsFor(plan)[field]
  if (limit === null || used < limit) return
  throw planLimitError(plan, field, limit, message)
}

/** The error `assertPlanLimit` throws, for callers that test the limit themselves. */
export function planLimitError(plan: PlanName, field: keyof TierCaps, limit: number, message: string, messageKey = `plan.limit.${field}`) {
  return createError({
    statusCode: 409,
    message: `${message} ${limitUpgradeHint()}`,
    data: {
      code: PLAN_LIMIT_REACHED_CODE,
      field,
      limit,
      plan,
      messageKey,
      recovery: limitRecovery()
    }
  })
}

/** Oldest activity timestamp the plan may view, or `null` for no limit. */
export function historyCutoff(plan: PlanName, now: Date = new Date()): Date | null {
  const days = capsFor(plan).historyDays
  return days === null ? null : new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
}

/** Response header the activity endpoint sets when the plan's window hides older rows. */
export const HISTORY_LIMITED_HEADER = 'X-Markoto-History-Limited-Days'

/**
 * Refuse access to an activity row older than the plan's history window
 * (diff, comment context, restore). 409 `plan/limit-reached` with
 * `field: 'historyDays'`; the row itself stays stored.
 */
export function assertWithinHistory(plan: PlanName, createdAt: Date, now: Date = new Date()): void {
  const cutoff = historyCutoff(plan, now)
  if (cutoff === null || createdAt.getTime() >= cutoff.getTime()) return
  throw planLimitError(
    plan,
    'historyDays',
    capsFor(plan).historyDays ?? 0,
    'This change is older than the history your plan includes.',
    'plan.limit.historyEntry'
  )
}
