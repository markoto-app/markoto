import { litellmKeyGenerateResponse, litellmKeyInfoResponse, litellmTeamInfoResponse, type LitellmTeamInfo } from './adminResponses'
import { clearMemberKey, getStoredMemberKey, listMemberKeysOfUser, listMembersWithKeys, storeMemberKeyIfAbsent, storeWorkspaceTeamId } from '../../repos/litellmKeys'
import { listAllWorkspaceSubscriptions } from '../../repos/workspaceSubscriptions'
import { system } from '../../repos/proofs'
import { openSecretOrNull, sealSecret, secretContext } from '../platform/secretBox'
import { litellmAdminFetch } from './litellmAdmin'
import { isDuplicateTeamError } from './freeTierTeam'
import { memberLimitUsd, pooledFromRow, workspaceAiBudgetUsd, workspacePoolCaps, type PooledWorkspace } from '../billing/workspaceBilling'
import { isBillingEnabled } from '../billing/billingMode'
import { creditBudgetExtraUsd } from '../billing/aiCreditBudget'
import { useEnv } from '~~/shared/env/load'
import { useLogger } from '../platform/logger'

const log = useLogger('litellm-teams')

// One LiteLLM team per Team / Business workspace.
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
  return useEnv().test.litellmStub
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

type TeamInfo = LitellmTeamInfo

export async function readWorkspaceTeam(workspaceId: string): Promise<TeamInfo | null> {
  if (isStubMode()) return null
  const res = await litellmAdminFetch(`/team/info?team_id=${encodeURIComponent(workspaceTeamId(workspaceId))}`)
  if (res.status === 404) {
    await res.text().catch(() => '')
    return null
  }
  await failOnError(res, '/team/info')
  return litellmTeamInfoResponse.parse(await res.json()).team_info ?? null
}

/**
 * Create the workspace's team or bring its budget to seats × per-seat.
 * Idempotent; called from the Stripe webhook (after commit) and lazily
 * before the first member key.
 */
export async function ensureWorkspaceTeam(pool: PooledWorkspace): Promise<string> {
  const teamId = workspaceTeamId(pool.workspaceId)
  // Seats × per-seat (adjusted for seat changes in the current window)
  // + the workspace's top-up credits.
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
    await storeWorkspaceTeamId(pool.workspaceId, teamId)
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
      log.warn('/team/delete failed', { status: res.status })
    }
  } catch (e) {
    log.warn('/team/delete failed', { err: e })
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
  // Guests use their own AI budget, never the workspace's.
  return getStoredMemberKey(workspaceId, userId)
}

export interface MemberKeyHandle {
  keyId: string
  token: string
}

function sealMemberKey(workspaceId: string, userId: number, token: string): string {
  return sealSecret('litellm-member-key', secretContext.litellmMemberKey(workspaceId, userId), token)
}

/** A member's stored workspace key token, or null when it can't be decrypted. */
export function openMemberKey(workspaceId: string, userId: number, sealed: string): string | null {
  return openSecretOrNull('litellm-member-key', secretContext.litellmMemberKey(workspaceId, userId), sealed)
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
    const token = openMemberKey(pool.workspaceId, userId, member.litellmKeyToken)
    if (token) return { keyId: member.litellmKeyId, token }
    // Unreadable (encryption key lost or rotated without _PREVIOUS): retire
    // it by id (LiteLLM's /key/delete takes the hashed id too) and mint anew.
    await deleteKeyTokens([member.litellmKeyId])
    await clearMemberKey(pool.workspaceId, userId, member.litellmKeyId)
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
    const payload = litellmKeyGenerateResponse.parse(await res.json())
    const token = payload.key
    const keyId = payload.token_id ?? payload.token ?? ''
    if (!token || !keyId) throw new Error('[workspaceTeams] /key/generate response missing key or token_id')
    handle = { keyId, token }
  }
  // Only store when no concurrent request stored one first; on a race the
  // loser's key is deleted and the stored one used.
  if (await storeMemberKeyIfAbsent(pool.workspaceId, userId, handle.keyId, sealMemberKey(pool.workspaceId, userId, handle.token))) return handle
  if (!isStubMode()) await deleteKeyTokens([handle.token])
  const winner = await readMember(pool.workspaceId, userId)
  const winnerToken = winner?.litellmKeyId && winner.litellmKeyToken ? openMemberKey(pool.workspaceId, userId, winner.litellmKeyToken) : null
  if (winner?.litellmKeyId && winnerToken) {
    return { keyId: winner.litellmKeyId, token: winnerToken }
  }
  return null
}

/** Apply a member's (new) limit to their key, if they have one. */
export async function syncMemberKeyLimit(pool: PooledWorkspace, userId: number): Promise<void> {
  if (isStubMode()) return
  const member = await readMember(pool.workspaceId, userId)
  if (!member?.litellmKeyToken) return
  // Unreadable: ensureMemberKey replaces it (with the current limit) on next use.
  const token = openMemberKey(pool.workspaceId, userId, member.litellmKeyToken)
  if (!token) return
  const limit = memberLimitUsd(member, workspacePoolCaps(pool.plan, pool.seats))
  await failOnError(await litellmAdminFetch('/key/update', {
    method: 'POST',
    body: JSON.stringify({ key: token, max_budget: limit })
  }), '/key/update')
}

/**
 * Re-apply every member key's limit (the default member limit follows
 * the plan; called after a plan change).
 */
export async function syncAllMemberKeyLimits(pool: PooledWorkspace): Promise<void> {
  if (isStubMode()) return
  for (const userId of await listMembersWithKeys(pool.workspaceId)) await syncMemberKeyLimit(pool, userId)
}

/** Delete a member's workspace key (member removed / left). Best-effort. */
export async function deleteMemberKey(workspaceId: string, userId: number): Promise<void> {
  const member = await readMember(workspaceId, userId)
  if (member?.litellmKeyToken && !isStubMode()) {
    try {
      // An unreadable token is deleted by its hashed id instead.
      const key = openMemberKey(workspaceId, userId, member.litellmKeyToken) ?? member.litellmKeyId
      if (key) await deleteKeyTokens([key])
    } catch (e) {
      log.warn('member key deletion failed', { err: e })
    }
  }
  if (member?.litellmKeyId) {
    await clearMemberKey(workspaceId, userId)
  }
}

/** Every workspace key token a user holds (account deletion). */
export async function listMemberKeyTokens(userId: number): Promise<string[]> {
  const rows = await listMemberKeysOfUser(userId)
  const tokens: string[] = []
  for (const row of rows) {
    // An unreadable token is deleted by its hashed id instead.
    const key = (row.token ? openMemberKey(row.workspaceId, userId, row.token) : null) ?? row.keyId
    if (key) tokens.push(key)
  }
  return tokens
}

export async function deleteKeyTokens(tokens: string[]): Promise<void> {
  if (tokens.length === 0 || isStubMode()) return
  const res = await litellmAdminFetch('/key/delete', { method: 'POST', body: JSON.stringify({ keys: tokens }) })
  if (!res.ok && res.status !== 404) {
    log.warn('/key/delete failed', { status: res.status })
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
  const { info } = litellmKeyInfoResponse.parse(await res.json())
  return { spend: info?.spend ?? 0, maxBudget: info?.max_budget ?? null }
}

/**
 * Bring every entitled workspace's team budget and member-key limits in
 * line with its subscription (missed webhook, changed `TIER_*` per-seat
 * budget). Run by `litellm-key-reconcile` at boot + every 6 h.
 */
export async function reconcileWorkspaceTeams(): Promise<{ checked: number, failed: number }> {
  const summary = { checked: 0, failed: 0 }
  if (isStubMode() || !isBillingEnabled()) return summary
  const rows = await listAllWorkspaceSubscriptions(system('litellm-reconcile'))
  for (const row of rows) {
    const pool = pooledFromRow(row)
    if (!pool) continue
    summary.checked++
    try {
      await ensureWorkspaceTeam(pool)
      await syncAllMemberKeyLimits(pool)
    } catch (e) {
      summary.failed++
      log.warn('reconcile failed', { workspaceId: row.workspaceId, err: e })
    }
  }
  return summary
}
