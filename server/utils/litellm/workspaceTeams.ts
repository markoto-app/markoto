import { and, eq, isNotNull, isNull, ne } from 'drizzle-orm'
import { workspaceMembers, workspaceSubscriptions } from '../../db/schema'
import { useDatabase } from '../platform/database'
import { encryptToken, decryptToken } from './tokenCrypto'
import { litellmAdminFetch } from './litellmAdmin'
import { isDuplicateTeamError } from './freeTierTeam'
import { memberLimitUsd, pooledFromRow, workspaceAiBudgetUsd, workspacePoolCaps, type PooledWorkspace } from '../billing/workspaceBilling'
import { isBillingEnabled } from '../billing/billingMode'
import { creditBudgetExtraUsd } from '../billing/aiCreditBudget'

// One LiteLLM team per Team / Business workspace (pricing plan WP3).
//
//   team  `markoto-ws-<workspaceId>`: max_budget = seats × per-seat budget,
//         budget_duration 30d — the workspace's pooled AI budget.
//   keys  one per (workspace, member), in that team, created on the
//         member's first AI use there; max_budget = the member's limit
//         (`memberLimitUsd`, null = only the team budget applies).
// LiteLLM checks the key's AND the team's budget before every call, the
// same mechanism as the free-tier pool (`freeTierTeam.ts`). A member's
// personal key (`users.litellm_key_*`) is untouched; it's used outside
// the workspace.
//
// `LITELLM_TEST_STUB=1` (unit / repos tiers) short-circuits every proxy
// call, like `userKeys.ts`.
//
// Never send `workspace_id` in a LiteLLM body (not even inside
// `metadata`): LiteLLM has its own workspace concept and rejects it with
// 401 "workspace_id is not allowed in request body". Ours travels as
// `markoto_workspace`.

const WORKSPACE_TEAM_PREFIX = 'markoto-ws-'
const WORKSPACE_TEAM_BUDGET_DURATION = '30d'
const TEST_STUB_TOKEN = 'sk-fake-test-workspace-key'

export const TEAM_BUDGET_EXHAUSTED_MESSAGE
  = 'This workspace\'s AI budget is used up for this month. Ask a workspace admin to add seats or credits.'
export const MEMBER_LIMIT_REACHED_MESSAGE
  = 'You\'ve reached your AI limit in this workspace for this month. Ask a workspace admin to raise it.'

function isStubMode(): boolean {
  return process.env.LITELLM_TEST_STUB === '1'
}

export function workspaceTeamId(workspaceId: string): string {
  return `${WORKSPACE_TEAM_PREFIX}${workspaceId}`
}

/** A LiteLLM budget error raised by a workspace TEAM (not the member key). */
export function isWorkspaceTeamBudgetError(err: unknown): boolean {
  const msg = errorText(err)
  return msg.includes(`Team=${WORKSPACE_TEAM_PREFIX}`) && /Budget has been exceeded|budget_exceeded/i.test(msg)
}

function errorText(err: unknown): string {
  if (!err) return ''
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return JSON.stringify(err)
}

async function failOnError(res: Response, what: string): Promise<void> {
  if (res.ok) return
  const text = await res.text().catch(() => '')
  throw new Error(`[workspaceTeams] ${what} failed: ${res.status} ${text.slice(0, 200)}`)
}

interface TeamInfo {
  max_budget?: number | null
  spend?: number | null
  budget_duration?: string | null
  budget_reset_at?: string | null
}

export async function readWorkspaceTeam(workspaceId: string): Promise<TeamInfo | null> {
  if (isStubMode()) return null
  const res = await litellmAdminFetch(`/team/info?team_id=${encodeURIComponent(workspaceTeamId(workspaceId))}`)
  if (res.status === 404) {
    await res.text().catch(() => '')
    return null
  }
  await failOnError(res, '/team/info')
  const payload = await res.json() as { team_info?: TeamInfo }
  return payload.team_info ?? null
}

/**
 * Create the workspace's team or bring its budget to seats × per-seat.
 * Idempotent; called from the Stripe webhook (after commit) and lazily
 * before the first member key.
 */
export async function ensureWorkspaceTeam(pool: PooledWorkspace): Promise<string> {
  const teamId = workspaceTeamId(pool.workspaceId)
  // Seats × per-seat (adjusted for seat changes in the current window)
  // + the workspace's top-up credits (WP4).
  const budget = Math.round((workspaceAiBudgetUsd(pool)
    + await creditBudgetExtraUsd({ type: 'workspace', id: pool.workspaceId })) * 10_000) / 10_000
  if (!isStubMode()) {
    let existing = await readWorkspaceTeam(pool.workspaceId)
    if (!existing) {
      const res = await litellmAdminFetch('/team/new', {
        method: 'POST',
        body: JSON.stringify({
          team_id: teamId,
          team_alias: teamId,
          max_budget: budget,
          budget_duration: WORKSPACE_TEAM_BUDGET_DURATION,
          metadata: { purpose: 'markoto workspace AI pool', markoto_workspace: pool.workspaceId }
        })
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        if (!isDuplicateTeamError(text)) throw new Error(`[workspaceTeams] /team/new failed: ${res.status} ${text.slice(0, 200)}`)
        existing = await readWorkspaceTeam(pool.workspaceId)
      }
    }
    if (existing && (existing.max_budget !== budget || existing.budget_duration !== WORKSPACE_TEAM_BUDGET_DURATION)) {
      await failOnError(await litellmAdminFetch('/team/update', {
        method: 'POST',
        body: JSON.stringify({ team_id: teamId, max_budget: budget, budget_duration: WORKSPACE_TEAM_BUDGET_DURATION })
      }), '/team/update')
    }
  }
  if (pool.subscription.litellmTeamId !== teamId) {
    await useDatabase().update(workspaceSubscriptions)
      .set({ litellmTeamId: teamId })
      .where(eq(workspaceSubscriptions.workspaceId, pool.workspaceId))
  }
  return teamId
}

/** Delete the workspace's team (workspace deleted). Best-effort. */
export async function deleteWorkspaceTeam(workspaceId: string): Promise<void> {
  if (isStubMode()) return
  try {
    const res = await litellmAdminFetch('/team/delete', {
      method: 'POST',
      body: JSON.stringify({ team_ids: [workspaceTeamId(workspaceId)] })
    })
    if (!res.ok && res.status !== 404) {
      console.warn(`[workspaceTeams] /team/delete failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`)
    }
  } catch (e) {
    console.warn(`[workspaceTeams] /team/delete failed: ${e instanceof Error ? e.message : e}`)
  }
}

async function addTeamMember(teamId: string, userId: number): Promise<void> {
  const res = await litellmAdminFetch('/team/member_add', {
    method: 'POST',
    body: JSON.stringify({ team_id: teamId, member: { role: 'user', user_id: String(userId) } })
  })
  if (res.ok) return
  const text = await res.text().catch(() => '')
  if (/already in team|team_member_already_in_team|Unique constraint failed/i.test(text)) return
  throw new Error(`[workspaceTeams] /team/member_add failed: ${res.status} ${text.slice(0, 200)}`)
}

interface MemberRow {
  aiLimitUsd: number | null
  aiUnlimited: boolean
  litellmKeyId: string | null
  litellmKeyToken: string | null
}

async function readMember(workspaceId: string, userId: number): Promise<MemberRow | null> {
  const row = (await useDatabase()
    .select({
      aiLimitUsd: workspaceMembers.aiLimitUsd,
      aiUnlimited: workspaceMembers.aiUnlimited,
      litellmKeyId: workspaceMembers.litellmKeyId,
      litellmKeyToken: workspaceMembers.litellmKeyToken
    })
    .from(workspaceMembers)
    // Guests (WP11) use their own AI budget, never the workspace's.
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId), ne(workspaceMembers.role, 'guest')))
    .limit(1))[0]
  return row ?? null
}

export interface MemberKeyHandle {
  keyId: string
  token: string
}

/**
 * The member's key in the workspace team, created on first use.
 * Returns null when the user isn't a member (callers then bill the
 * user's personal key).
 */
export async function ensureMemberKey(pool: PooledWorkspace, userId: number): Promise<MemberKeyHandle | null> {
  const member = await readMember(pool.workspaceId, userId)
  if (!member) return null
  if (member.litellmKeyId && member.litellmKeyToken) {
    return { keyId: member.litellmKeyId, token: decryptToken(member.litellmKeyToken) }
  }
  let handle: MemberKeyHandle
  if (isStubMode()) {
    handle = { keyId: `test-stub-ws-${pool.workspaceId}-${userId}`, token: TEST_STUB_TOKEN }
  } else {
    const teamId = await ensureWorkspaceTeam(pool)
    await addTeamMember(teamId, userId)
    const limit = memberLimitUsd(member, workspacePoolCaps(pool.plan, pool.seats))
    const res = await litellmAdminFetch('/key/generate', {
      method: 'POST',
      body: JSON.stringify({
        team_id: teamId,
        user_id: String(userId),
        max_budget: limit,
        budget_duration: WORKSPACE_TEAM_BUDGET_DURATION,
        rpm_limit: 60,
        key_alias: `${teamId}-u${userId}`,
        metadata: { allow_client_tags: true, markoto_workspace: pool.workspaceId }
      })
    })
    await failOnError(res, '/key/generate')
    const payload = await res.json() as { key?: string, token_id?: string, token?: string }
    const token = payload.key
    const keyId = payload.token_id ?? payload.token ?? ''
    if (!token || !keyId) throw new Error('[workspaceTeams] /key/generate response missing key or token_id')
    handle = { keyId, token }
  }
  // Only store when no concurrent request stored one first; on a race the
  // loser's key is deleted and the stored one used.
  const stored = await useDatabase().update(workspaceMembers)
    .set({ litellmKeyId: handle.keyId, litellmKeyToken: encryptToken(handle.token) })
    .where(and(
      eq(workspaceMembers.workspaceId, pool.workspaceId),
      eq(workspaceMembers.userId, userId),
      isNull(workspaceMembers.litellmKeyId)
    ))
    .returning({ userId: workspaceMembers.userId })
  if (stored.length > 0) return handle
  if (!isStubMode()) await deleteKeyTokens([handle.token])
  const winner = await readMember(pool.workspaceId, userId)
  if (winner?.litellmKeyId && winner.litellmKeyToken) {
    return { keyId: winner.litellmKeyId, token: decryptToken(winner.litellmKeyToken) }
  }
  return null
}

/** Apply a member's (new) limit to their key, if they have one. */
export async function syncMemberKeyLimit(pool: PooledWorkspace, userId: number): Promise<void> {
  if (isStubMode()) return
  const member = await readMember(pool.workspaceId, userId)
  if (!member?.litellmKeyToken) return
  const limit = memberLimitUsd(member, workspacePoolCaps(pool.plan, pool.seats))
  await failOnError(await litellmAdminFetch('/key/update', {
    method: 'POST',
    body: JSON.stringify({ key: decryptToken(member.litellmKeyToken), max_budget: limit })
  }), '/key/update')
}

/**
 * Re-apply every member key's limit (the default member limit follows
 * the plan; called after a plan change).
 */
export async function syncAllMemberKeyLimits(pool: PooledWorkspace): Promise<void> {
  if (isStubMode()) return
  const rows = await useDatabase()
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, pool.workspaceId), isNotNull(workspaceMembers.litellmKeyToken)))
  for (const row of rows) await syncMemberKeyLimit(pool, row.userId)
}

/** Delete a member's workspace key (member removed / left). Best-effort. */
export async function deleteMemberKey(workspaceId: string, userId: number): Promise<void> {
  const member = await readMember(workspaceId, userId)
  if (member?.litellmKeyToken && !isStubMode()) {
    try {
      await deleteKeyTokens([decryptToken(member.litellmKeyToken)])
    } catch (e) {
      console.warn(`[workspaceTeams] member key deletion failed: ${e instanceof Error ? e.message : e}`)
    }
  }
  if (member?.litellmKeyId) {
    await useDatabase().update(workspaceMembers)
      .set({ litellmKeyId: null, litellmKeyToken: null })
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
  }
}

/** Every workspace key token a user holds (account deletion). */
export async function listMemberKeyTokens(userId: number): Promise<string[]> {
  const rows = await useDatabase()
    .select({ token: workspaceMembers.litellmKeyToken })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, userId), isNotNull(workspaceMembers.litellmKeyToken)))
  const tokens: string[] = []
  for (const row of rows) {
    try {
      if (row.token) tokens.push(decryptToken(row.token))
    } catch {
      // unreadable token: nothing to delete upstream
    }
  }
  return tokens
}

export async function deleteKeyTokens(tokens: string[]): Promise<void> {
  if (tokens.length === 0 || isStubMode()) return
  const res = await litellmAdminFetch('/key/delete', { method: 'POST', body: JSON.stringify({ keys: tokens }) })
  if (!res.ok && res.status !== 404) {
    console.warn(`[workspaceTeams] /key/delete failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`)
  }
}

export interface KeySpend {
  spend: number
  maxBudget: number | null
}

/** Spend of a member's workspace key (0 when none yet). */
export async function readMemberKeySpend(token: string | null): Promise<KeySpend | null> {
  if (!token || isStubMode()) return null
  const res = await litellmAdminFetch(`/key/info?key=${encodeURIComponent(token)}`)
  if (!res.ok) {
    await res.text().catch(() => '')
    return null
  }
  const payload = await res.json() as { info?: { spend?: number, max_budget?: number | null } }
  return {
    spend: typeof payload.info?.spend === 'number' ? payload.info.spend : 0,
    maxBudget: typeof payload.info?.max_budget === 'number' ? payload.info.max_budget : null
  }
}

/**
 * Bring every entitled workspace's team budget and member-key limits in
 * line with its subscription (missed webhook, changed `TIER_*` per-seat
 * budget). Run by `litellm-key-reconcile` at boot + every 6 h.
 */
export async function reconcileWorkspaceTeams(): Promise<{ checked: number, failed: number }> {
  const summary = { checked: 0, failed: 0 }
  if (isStubMode() || !isBillingEnabled()) return summary
  const rows = await useDatabase().select().from(workspaceSubscriptions)
  for (const row of rows) {
    const pool = pooledFromRow(row)
    if (!pool) continue
    summary.checked++
    try {
      await ensureWorkspaceTeam(pool)
      await syncAllMemberKeyLimits(pool)
    } catch (e) {
      summary.failed++
      console.warn(`[workspaceTeams] reconcile of ${row.workspaceId} failed: ${e instanceof Error ? e.message : e}`)
    }
  }
  return summary
}
