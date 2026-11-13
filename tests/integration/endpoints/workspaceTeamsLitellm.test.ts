import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { createError } from 'h3'
import { resetDb, testDb } from '../setup/db'
import { createUser, createWorkspace, setMemberRole } from '../setup/fixtures'
import { applyTestEnv } from '../setup/testEnv'
import { LITELLM_MASTER_KEY, LITELLM_URL, waitFor } from '../setup/byok'

// Team / Business workspace AI budgets against the REAL
// `litellm-test` proxy. Runs the production helpers in-process (the
// integration server uses `LITELLM_TEST_STUB=1`), so the /team/* and
// /key/* contracts and LiteLLM's budget errors are what the proxy really
// does:
//   - one team per workspace, max_budget = seats × per-seat budget;
//   - one key per member IN that team, max_budget = the member limit;
//   - a member over their limit and a team over its budget are refused
//     with errors the loop tells apart (member limit vs team budget).
// Spend comes from the dictation billing tick (`voxtral-realtime-tick`,
// $0.006, no upstream call).

const envBefore = { ...process.env }
const globalsBefore = { createError: Reflect.get(globalThis, 'createError') }

applyTestEnv()
process.env.LITELLM_TEST_STUB = ''
process.env.NUXT_BILLING_ENABLED = 'true'
// The code under test reads the proxy from the typed env (shared/env).
process.env.NUXT_LITELLM_URL = LITELLM_URL
process.env.NUXT_LITELLM_MASTER_KEY = LITELLM_MASTER_KEY
Object.assign(globalThis, { createError })

const teams = await import('../../../server/utils/litellm/workspaceTeams')
const { getPooledWorkspace } = await import('../../../server/utils/billing/workspaceBilling')
const { isBudgetExceededError } = await import('../../../server/utils/litellm/userKeys')
const { useLitellmForUser } = await import('../../../server/utils/ai/litellmClient')

async function admin(path: string, body?: unknown): Promise<{ status: number, json: Record<string, unknown> }> {
  const res = await fetch(`${LITELLM_URL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Authorization': `Bearer ${LITELLM_MASTER_KEY}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) json = parsed as Record<string, unknown>
  } catch { /* non-JSON error body */ }
  return { status: res.status, json }
}

async function info(path: string, field: string): Promise<Record<string, unknown>> {
  const { status, json } = await admin(path)
  expect(status).toBe(200)
  const v = json[field]
  return typeof v === 'object' && v !== null ? v as Record<string, unknown> : {}
}

const createdTeams: string[] = []

async function pooledWorkspace(seats = 3) {
  const owner = await createUser()
  const ws = await createWorkspace(owner.id)
  await testDb().query(
    `INSERT INTO workspace_subscriptions (workspace_id, plan, seats, status, billing_admin_id, stripe_customer_id, stripe_subscription_id, valid_until)
     VALUES ($1, 'team', $2, 'active', $3, $4, $5, now() + interval '30 days')`,
    [ws.workspaceId, seats, owner.id, `cus_${ws.workspaceId}`, `sub_${ws.workspaceId}`]
  )
  createdTeams.push(teams.workspaceTeamId(ws.workspaceId))
  const pool = await getPooledWorkspace(ws.workspaceId)
  expect(pool).not.toBeNull()
  return { owner, ws, pool: pool! }
}

async function tick(token: string): Promise<void> {
  await useLitellmForUser(token).chat.completions.create({ model: 'voxtral-realtime-tick', messages: [{ role: 'user', content: 'tick' }] })
}

async function chatError(token: string): Promise<unknown> {
  try {
    await tick(token)
    return null
  } catch (e) {
    return e
  }
}

beforeEach(async () => {
  await resetDb()
})

afterAll(async () => {
  if (createdTeams.length > 0) await admin('/team/delete', { team_ids: createdTeams })
  for (const k of Object.keys(process.env)) {
    if (!(k in envBefore)) Reflect.deleteProperty(process.env, k)
  }
  Object.assign(process.env, envBefore)
  Object.assign(globalThis, globalsBefore)
})

describe('workspace team + member keys (real LiteLLM)', () => {
  it('creates the team at seats × per-seat and a member key in it at the default limit; reuses it', async () => {
    const { owner, ws, pool } = await pooledWorkspace(3)
    const key = await teams.ensureMemberKey(pool, owner.id)
    expect(key).not.toBeNull()

    const team = await info(`/team/info?team_id=${teams.workspaceTeamId(ws.workspaceId)}`, 'team_info')
    expect(team.max_budget).toBe(15)
    expect(team.budget_duration).toBe('30d')
    const k = await info(`/key/info?key=${encodeURIComponent(key!.token)}`, 'info')
    expect(k.team_id).toBe(teams.workspaceTeamId(ws.workspaceId))
    expect(k.max_budget).toBe(10)

    const again = await teams.ensureMemberKey(pool, owner.id)
    expect(again?.keyId).toBe(key!.keyId)
    const stored = (await testDb().query('SELECT litellm_team_id FROM workspace_subscriptions WHERE workspace_id = $1', [ws.workspaceId])).rows[0]
    expect(stored?.litellm_team_id).toBe(teams.workspaceTeamId(ws.workspaceId))
  })

  it('a non-member gets no workspace key', async () => {
    const { pool } = await pooledWorkspace(3)
    const stranger = await createUser()
    expect(await teams.ensureMemberKey(pool, stranger.id)).toBeNull()
  })

  it('seat changes move the team budget; limit changes move the key budget', async () => {
    const { owner, ws, pool } = await pooledWorkspace(3)
    const key = await teams.ensureMemberKey(pool, owner.id)
    await teams.ensureWorkspaceTeam({ ...pool, seats: 5 })
    expect((await info(`/team/info?team_id=${teams.workspaceTeamId(ws.workspaceId)}`, 'team_info')).max_budget).toBe(25)

    await testDb().query('UPDATE workspace_members SET ai_unlimited = true WHERE workspace_id = $1 AND user_id = $2', [ws.workspaceId, owner.id])
    await teams.syncMemberKeyLimit(pool, owner.id)
    expect((await info(`/key/info?key=${encodeURIComponent(key!.token)}`, 'info')).max_budget ?? null).toBeNull()
  })

  it('a member over their own limit is refused with a key budget error, not the team one', async () => {
    const { owner, ws, pool } = await pooledWorkspace(3)
    const key = await teams.ensureMemberKey(pool, owner.id)
    await tick(key!.token)
    await waitFor(async () => {
      const spend = Number((await info(`/key/info?key=${encodeURIComponent(key!.token)}`, 'info')).spend ?? 0)
      return spend > 0 ? spend : null
    }, 45_000, 'the tick to reach the key spend')
    await testDb().query('UPDATE workspace_members SET ai_limit_usd = 0.001 WHERE workspace_id = $1 AND user_id = $2', [ws.workspaceId, owner.id])
    await teams.syncMemberKeyLimit(pool, owner.id)

    const err = await chatError(key!.token)
    expect(err).not.toBeNull()
    expect(isBudgetExceededError(err)).toBe(true)
    expect(teams.isWorkspaceTeamBudgetError(err)).toBe(false)
  })

  it('a used-up team refuses every member with the team budget error', async () => {
    const { owner, ws, pool } = await pooledWorkspace(3)
    const other = await createUser()
    await setMemberRole(ws.workspaceId, other.id, 'editor')
    const ownerKey = await teams.ensureMemberKey(pool, owner.id)
    const otherKey = await teams.ensureMemberKey(pool, other.id)
    const teamId = teams.workspaceTeamId(ws.workspaceId)
    await tick(ownerKey!.token)
    const spent = await waitFor(async () => {
      const spend = Number((await info(`/team/info?team_id=${teamId}`, 'team_info')).spend ?? 0)
      return spend > 0 ? spend : null
    }, 45_000, 'the tick to reach the team spend')
    expect((await admin('/team/update', { team_id: teamId, max_budget: spent / 2 })).status).toBe(200)

    const err = await chatError(otherKey!.token)
    expect(err).not.toBeNull()
    expect(teams.isWorkspaceTeamBudgetError(err)).toBe(true)
  })

  it('deleting a member key removes it from the proxy and the row', async () => {
    const { owner, ws, pool } = await pooledWorkspace(3)
    const key = await teams.ensureMemberKey(pool, owner.id)
    await teams.deleteMemberKey(ws.workspaceId, owner.id)
    // The deleted key no longer authenticates (`/key/info` answers from
    // LiteLLM's cache for a while, so it is not a usable signal).
    const asKey = await fetch(`${LITELLM_URL}/v1/models`, { headers: { Authorization: `Bearer ${key!.token}` } })
    expect(asKey.status).toBe(401)
    const row = (await testDb().query('SELECT litellm_key_id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [ws.workspaceId, owner.id])).rows[0]
    expect(row?.litellm_key_id).toBeNull()
  })
})
