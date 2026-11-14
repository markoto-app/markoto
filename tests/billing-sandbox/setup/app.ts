import { nanoid } from 'nanoid'
import { expect } from 'vitest'
import { testDb } from '../../integration/setup/db'
import { loggedInClient, type TestClient } from '../../integration/setup/client'
import { createUser, type TestUser } from '../../integration/setup/fixtures'
import { LITELLM_MASTER_KEY, LITELLM_URL } from '../../integration/setup/byok'
import { first } from '../../helpers/assert'
import { DEFAULT_TIERS } from '../../../shared/config/tiers'
import { SANDBOX_BASE_URL, WORKSPACE_ID_PREFIX, runId } from './env'

// What the suites know about the app: signed-in users, the endpoints a
// billing page reads, and the LiteLLM budgets behind them. The tier never
// truncates the database: every scenario works on rows it created, so the
// files can run side by side.

export interface AppUser {
  user: TestUser
  client: TestClient
}

/** A fresh user (onboarding done), signed in on the sandbox server. */
export async function signedInUser(label: string): Promise<AppUser> {
  const user = await createUser({
    name: `Sandbox ${label}`,
    email: `bsx-${runId()}-${label}-${nanoid(6)}@test.local`.toLowerCase()
  })
  return { user, client: await loggedInClient(user.id, user.name, SANDBOX_BASE_URL) }
}

/** A workspace of the suite, `owner` its only member (an admin). */
export async function createSuiteWorkspace(owner: TestUser, label: string): Promise<string> {
  const workspaceId = `${WORKSPACE_ID_PREFIX}-${runId()}-${label}-${nanoid(4)}`.toLowerCase()
  await testDb().query('INSERT INTO workspaces (workspace_id, owner_id, name) VALUES ($1, $2, $3)', [workspaceId, owner.id, `Sandbox ${label}`])
  await testDb().query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [workspaceId, owner.id])
  return workspaceId
}

async function readJson<T>(res: Response, what: string): Promise<T> {
  const text = await res.text()
  if (!res.ok) throw new Error(`[billing-sandbox] ${what} answered ${res.status}: ${text.slice(0, 300)}`)
  return JSON.parse(text) as T
}

/** `GET /api/user/billing`, the fields the suites assert. */
export interface UserBillingView {
  plan: 'free' | 'pro' | 'team' | 'business'
  periodStart: string
  periodEnd: string
  interval: 'month' | 'year' | null
  cancelAt: string | null
  credits: { usableUsd: number, usedThisMonthUsd: number, grants: Array<{ pack: string, amountUsd: number, remainingUsd: number, refundedUsd: number, expiresAt: string, createdAt: string }> } | null
  coveringWorkspaces: Array<{ workspaceId: string, plan: 'team' | 'business' }>
}

export async function userBilling(client: TestClient): Promise<UserBillingView> {
  return readJson(await client.get('/api/user/billing'), 'GET /api/user/billing')
}

/** `GET /api/ai/credits`. */
export interface AiCreditsView {
  pointsRemaining: number
  pointsTotal: number
  planPointsRemaining: number
  creditPoints: number
  plan: 'free' | 'pro' | 'team' | 'business'
  periodEnd: string
  attribution: 'user' | 'workspace'
  workspace: { workspaceId: string, teamBudgetUsd: number, teamSpendUsd: number, memberLimitUsd: number | null } | null
}

export async function aiCredits(client: TestClient, workspaceId?: string): Promise<AiCreditsView> {
  const path = workspaceId ? `/api/ai/credits?workspaceId=${encodeURIComponent(workspaceId)}` : '/api/ai/credits'
  return readJson(await client.get(path), `GET ${path}`)
}

/** `GET /api/workspaces/:wsId/billing`. */
export interface WorkspaceBillingView {
  billingEnabled: boolean
  seatsUsed: number
  isBillingAdmin: boolean
  subscription: {
    plan: 'team' | 'business'
    seats: number
    status: string
    entitled: boolean
    interval: 'month' | 'year'
    currency: 'eur' | 'chf'
    currentPeriodStart: string | null
    validUntil: string | null
    cancelAt: string | null
    billingAdminId: number | null
  } | null
  pool: { aiBudgetUsd: number, aiSpendUsd: number | null, defaultMemberLimitUsd: number } | null
  credits: UserBillingView['credits']
}

export async function workspaceBilling(client: TestClient, workspaceId: string): Promise<WorkspaceBillingView> {
  return readJson(await client.get(`/api/workspaces/${workspaceId}/billing`), 'GET workspace billing')
}

/** POST a billing mutation; the caller asserts the status. */
export async function post<T = Record<string, unknown>>(client: TestClient, path: string, body?: unknown): Promise<{ status: number, body: T }> {
  const res = await client.post(path, body)
  return { status: res.status, body: parseBody(await res.text()) as T }
}

function parseBody(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Unix seconds of an ISO timestamp the app returned. */
export function isoUnix(iso: string | null | undefined): number | null {
  return iso ? Math.floor(new Date(iso).getTime() / 1000) : null
}

/** The app shows exactly Stripe's timestamp (both are whole seconds). */
export function expectSameInstant(iso: string | null | undefined, stripeUnix: number): void {
  expect(isoUnix(iso)).toBe(stripeUnix)
}

// ── What the app stored ──────────────────────────────────────────────

export interface UserBillingRow {
  plan: string
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  billing_interval: string | null
  billing_currency: string | null
  plan_valid_until: Date | null
  plan_cancel_at: Date | null
  litellm_key_id: string | null
}

export async function userRow(userId: number): Promise<UserBillingRow> {
  const result = await testDb().query<UserBillingRow>(
    `SELECT plan, stripe_customer_id, stripe_subscription_id, billing_interval, billing_currency, plan_valid_until, plan_cancel_at, litellm_key_id
       FROM users WHERE id = $1`,
    [userId]
  )
  return first(result.rows)
}

/** Point a workspace's subscription row at another Stripe customer (the one on the suite's test clock). */
export async function setWorkspaceCustomer(workspaceId: string, customerId: string): Promise<void> {
  const result = await testDb().query('UPDATE workspace_subscriptions SET stripe_customer_id = $2 WHERE workspace_id = $1', [workspaceId, customerId])
  expect(result.rowCount).toBe(1)
}

export async function workspaceCustomerId(workspaceId: string): Promise<string | null> {
  const result = await testDb().query<{ stripe_customer_id: string | null }>('SELECT stripe_customer_id FROM workspace_subscriptions WHERE workspace_id = $1', [workspaceId])
  return result.rows[0]?.stripe_customer_id ?? null
}

// ── LiteLLM (the real litellm-test proxy) ────────────────────────────

/** The committed per-plan monthly AI budgets, USD (the sandbox server runs without `TIER_*` overrides). */
export const PLAN_BUDGET_USD = {
  free: DEFAULT_TIERS.free.litellmBudgetUsd,
  pro: DEFAULT_TIERS.pro.litellmBudgetUsd,
  team: DEFAULT_TIERS.team.litellmBudgetUsd,
  business: DEFAULT_TIERS.business.litellmBudgetUsd
} as const

async function litellmAdmin<T>(path: string): Promise<T | null> {
  const res = await fetch(`${LITELLM_URL}${path}`, { headers: { Authorization: `Bearer ${LITELLM_MASTER_KEY}` } })
  if (res.status === 404) return null
  return readJson(res, `LiteLLM ${path.split('?')[0]}`)
}

/** `max_budget` of the user's personal LiteLLM key, as the proxy enforces it. */
export async function userKeyBudgetUsd(userId: number): Promise<number | null> {
  const keyId = (await userRow(userId)).litellm_key_id
  if (!keyId) return null
  const info = await litellmAdmin<{ info?: { max_budget?: number | null } }>(`/key/info?key=${encodeURIComponent(keyId)}`)
  return info?.info?.max_budget ?? null
}

/** `max_budget` of the workspace's LiteLLM team, or null when there is no team. */
export async function workspaceTeamBudgetUsd(workspaceId: string): Promise<number | null> {
  const info = await litellmAdmin<{ team_info?: { max_budget?: number | null } }>(`/team/info?team_id=${encodeURIComponent(`markoto-ws-${workspaceId}`)}`)
  return info?.team_info?.max_budget ?? null
}
