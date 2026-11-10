import { describe, it, expect, beforeEach } from 'vitest'
import { getValkeyKey, resetDb, setValkeyKey, testDb } from '../setup/db'
import { loggedInClient, anonClient } from '../setup/client'
import { createDoc, createUser, createWorkspace, setMemberRole } from '../setup/fixtures'
import { TEST_BILLING_OFF_BASE_URL } from '../setup/env'

// Team / Business workspace billing (pricing plan WP3) against the
// billing-on test server: stripe-mock for Stripe; LiteLLM runs in stub
// mode there (`LITELLM_TEST_STUB=1`), so the team / key calls are
// covered by unit tests and the member key is a stub.
//
// stripe-mock answers every subscription retrieve with its canned
// subscription (status `active`, one item), so a row seeded with
// `stripe_subscription_id = 'sub_existing_test'` behaves like a live
// subscription for the change paths.

const FUTURE = new Date(Date.now() + 30 * 24 * 3600 * 1000)

async function seedSubscription(workspaceId: string, opts: { seats?: number, plan?: 'team' | 'business', status?: string, adminId?: number, currency?: 'eur' | 'chf' } = {}): Promise<void> {
  await testDb().query(
    `INSERT INTO workspace_subscriptions
       (workspace_id, plan, seats, status, billing_admin_id, stripe_customer_id, stripe_subscription_id, current_period_start, valid_until, currency, interval)
     VALUES ($1, $2, $3, $4, $5, 'cus_ws_seed', 'sub_existing_test', now(), $6, $7, 'month')`,
    [workspaceId, opts.plan ?? 'team', opts.seats ?? 3, opts.status ?? 'active', opts.adminId ?? null, FUTURE, opts.currency ?? 'eur']
  )
}

async function readSub(workspaceId: string): Promise<Record<string, unknown> | undefined> {
  const r = await testDb().query('SELECT * FROM workspace_subscriptions WHERE workspace_id = $1', [workspaceId])
  return r.rows[0]
}

async function addMembers(workspaceId: string, n: number): Promise<number[]> {
  const ids: number[] = []
  for (let i = 0; i < n; i++) {
    const u = await createUser()
    await setMemberRole(workspaceId, u.id, 'editor')
    ids.push(u.id)
  }
  return ids
}

describe('workspace billing — access', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('401 anonymous, 404 non-member, 403 editor, 200 admin', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const [editorId] = await addMembers(ws.workspaceId, 1)
    const stranger = await createUser()
    const path = `/api/workspaces/${ws.workspaceId}/billing`

    expect((await anonClient().get(path)).status).toBe(401)
    expect((await (await loggedInClient(stranger.id)).get(path)).status).toBe(404)
    const editorRes = await (await loggedInClient(editorId!)).get(path)
    expect(editorRes.status).toBe(403)
    expect((await editorRes.json() as { data?: { code?: string } }).data?.code).toBe('billing/admin-required')

    const res = await (await loggedInClient(admin.id)).get(path)
    expect(res.status).toBe(200)
    const body = await res.json() as { billingEnabled: boolean, subscription: unknown, seatsUsed: number, minSeats: number, members: unknown[] }
    expect(body).toMatchObject({ billingEnabled: true, subscription: null, seatsUsed: 2, minSeats: 3 })
    expect(body.members).toHaveLength(2)
  })

  it('billing off: checkout / seats / portal answer 404 billing/disabled; the overview still works', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const client = await loggedInClient(admin.id, undefined, TEST_BILLING_OFF_BASE_URL)
    for (const [path, body] of [['checkout', { plan: 'team', seats: 3 }], ['seats', { seats: 4 }], ['portal', {}]] as const) {
      const res = await client.post(`/api/workspaces/${ws.workspaceId}/billing/${path}`, body)
      expect(res.status, path).toBe(404)
      expect((await res.json() as { data?: { code?: string } }).data?.code, path).toBe('billing/disabled')
    }
    const overview = await client.get(`/api/workspaces/${ws.workspaceId}/billing`)
    expect(overview.status).toBe(200)
    expect((await overview.json() as { billingEnabled: boolean }).billingEnabled).toBe(false)
  })
})

describe('POST /api/workspaces/:wsId/billing/checkout', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('400 for a personal plan, garbage plan or too few seats', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const client = await loggedInClient(admin.id)
    for (const body of [{ plan: 'pro', seats: 3 }, { plan: 'x', seats: 3 }, { plan: 'team', seats: 2 }, { plan: 'team', seats: 'many' }, { plan: 'team', seats: 3, interval: 'week' }]) {
      const res = await client.post(`/api/workspaces/${ws.workspaceId}/billing/checkout`, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
  })

  it('409 billing/seats-below-members when the workspace already has more people', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    await addMembers(ws.workspaceId, 3)
    const res = await (await loggedInClient(admin.id)).post(`/api/workspaces/${ws.workspaceId}/billing/checkout`, { acceptPaidTerms: true, plan: 'team', seats: 3 })
    expect(res.status).toBe(409)
    expect((await res.json() as { data?: { code?: string, used?: number } }).data).toMatchObject({ code: 'billing/seats-below-members', used: 4 })
  })

  it('opens Checkout on the workspace\'s own customer and records an incomplete placeholder', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const res = await (await loggedInClient(admin.id)).post(`/api/workspaces/${ws.workspaceId}/billing/checkout`, { acceptPaidTerms: true, plan: 'team', seats: 5, interval: 'year', currency: 'chf' })
    expect(res.status).toBe(200)
    const body = await res.json() as { url?: string, sessionId?: string }
    expect(body.url).toMatch(/^https?:\/\//)
    expect(body.sessionId).toMatch(/^cs_/)
    const row = await readSub(ws.workspaceId)
    expect(row).toMatchObject({ plan: 'team', seats: 5, status: 'incomplete', billing_admin_id: admin.id, currency: 'chf', interval: 'year' })
    expect(row?.stripe_customer_id).toMatch(/^cus_/)
    // An incomplete subscription grants nothing: the workspace stays free.
    const ov = await (await loggedInClient(admin.id)).get(`/api/workspaces/${ws.workspaceId}/billing`)
    expect((await ov.json() as { subscription: { entitled: boolean } }).subscription.entitled).toBe(false)
  })

  it('changes the plan of a live subscription in place; currency is locked', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    await seedSubscription(ws.workspaceId, { adminId: admin.id })
    const client = await loggedInClient(admin.id)
    const res = await client.post(`/api/workspaces/${ws.workspaceId}/billing/checkout`, { acceptPaidTerms: true, plan: 'business', interval: 'year' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ updated: true, plan: 'business' })

    const locked = await client.post(`/api/workspaces/${ws.workspaceId}/billing/checkout`, { acceptPaidTerms: true, plan: 'business', currency: 'chf' })
    expect(locked.status).toBe(409)
    expect((await locked.json() as { data?: { code?: string } }).data?.code).toBe('billing/currency-locked')
  })
})

describe('POST /api/workspaces/:wsId/billing/seats', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('409 without a subscription, 409 below the people in the workspace, 200 otherwise', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const client = await loggedInClient(admin.id)
    const none = await client.post(`/api/workspaces/${ws.workspaceId}/billing/seats`, { seats: 4 })
    expect(none.status).toBe(409)
    expect((await none.json() as { data?: { code?: string } }).data?.code).toBe('billing/no-subscription')

    await seedSubscription(ws.workspaceId, { seats: 6, adminId: admin.id })
    await addMembers(ws.workspaceId, 3)
    const below = await client.post(`/api/workspaces/${ws.workspaceId}/billing/seats`, { seats: 3 })
    expect(below.status).toBe(409)
    expect((await below.json() as { data?: { code?: string } }).data?.code).toBe('billing/seats-below-members')

    const ok = await client.post(`/api/workspaces/${ws.workspaceId}/billing/seats`, { seats: 4 })
    expect(ok.status).toBe(200)
    expect((await readSub(ws.workspaceId))?.seats).toBe(4)
  })
})

describe('invites against the paid seats', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('409 billing/seats-full when every seat is taken; addSeat buys one and invites', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    await addMembers(ws.workspaceId, 2)
    await seedSubscription(ws.workspaceId, { seats: 3, adminId: admin.id })
    const client = await loggedInClient(admin.id)

    const full = await client.post(`/api/workspaces/${ws.workspaceId}/members`, { email: 'fourth@example.com' })
    expect(full.status).toBe(409)
    expect((await full.json() as { data?: { code?: string, seats?: number, used?: number } }).data).toMatchObject({ code: 'billing/seats-full', seats: 3, used: 3 })

    const added = await client.post(`/api/workspaces/${ws.workspaceId}/members`, { email: 'fourth@example.com', addSeat: true })
    expect(added.status).toBe(202)
    expect((await readSub(ws.workspaceId))?.seats).toBe(4)
  })

  it('two invites at once can\'t both take the last free seat', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    await addMembers(ws.workspaceId, 1)
    await seedSubscription(ws.workspaceId, { seats: 3, adminId: admin.id })
    const client = await loggedInClient(admin.id)
    const results = await Promise.all(['a@example.com', 'b@example.com', 'c@example.com'].map(email =>
      client.post(`/api/workspaces/${ws.workspaceId}/members`, { email })))
    // One free seat: exactly one invite gets it; the others are told the
    // seats are full or that another invite is in progress.
    expect(results.filter(r => r.status === 202)).toHaveLength(1)
    for (const r of results.filter(r => r.status !== 202)) {
      expect(r.status).toBe(409)
      expect(['billing/seats-full', 'billing/seats-busy']).toContain((await r.json() as { data?: { code?: string } }).data?.code)
    }
    expect((await testDb().query('SELECT count(*)::int AS n FROM workspace_invites WHERE workspace_id = $1', [ws.workspaceId])).rows[0].n).toBe(1)
    expect(await getValkeyKey(`lock:workspace-seats:${ws.workspaceId}`)).toBeNull()
  })

  it('a seat change in progress makes invites and seat changes wait (409 billing/seats-busy)', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    await seedSubscription(ws.workspaceId, { seats: 3, adminId: admin.id })
    await setValkeyKey(`lock:workspace-seats:${ws.workspaceId}`, '1')
    const client = await loggedInClient(admin.id)
    for (const res of [
      await client.post(`/api/workspaces/${ws.workspaceId}/members`, { email: 'x@example.com' }),
      await client.post(`/api/workspaces/${ws.workspaceId}/billing/seats`, { seats: 5 })
    ]) {
      expect(res.status).toBe(409)
      expect((await res.json() as { data?: { code?: string } }).data?.code).toBe('billing/seats-busy')
    }
    expect((await readSub(ws.workspaceId))?.seats).toBe(3)
  })

  it('a lapsed subscription doesn\'t limit invites by seats', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    await addMembers(ws.workspaceId, 2)
    await seedSubscription(ws.workspaceId, { seats: 3, adminId: admin.id, status: 'canceled' })
    const res = await (await loggedInClient(admin.id)).post(`/api/workspaces/${ws.workspaceId}/members`, { email: 'fourth@example.com' })
    expect(res.status).toBe(202)
  })
})

describe('member AI limits + pooled AI budget', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('PATCH sets a limit, no limit, or the default; 400 on garbage; 404 for a non-member', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const [memberId] = await addMembers(ws.workspaceId, 1)
    const client = await loggedInClient(admin.id)
    const path = `/api/workspaces/${ws.workspaceId}/billing/members/${memberId}`

    expect((await client.patch(path, { limitUsd: 3.5 })).status).toBe(200)
    let row = (await testDb().query('SELECT ai_limit_usd, ai_unlimited FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [ws.workspaceId, memberId])).rows[0]
    expect(row).toEqual({ ai_limit_usd: 3.5, ai_unlimited: false })

    expect((await client.patch(path, { limitUsd: null })).status).toBe(200)
    row = (await testDb().query('SELECT ai_limit_usd, ai_unlimited FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [ws.workspaceId, memberId])).rows[0]
    expect(row).toEqual({ ai_limit_usd: null, ai_unlimited: true })

    expect((await client.patch(path, { default: true })).status).toBe(200)
    for (const bad of [{ limitUsd: -1 }, { limitUsd: 'x' }, {}]) {
      expect((await client.patch(path, bad)).status, JSON.stringify(bad)).toBe(400)
    }
    const stranger = await createUser()
    expect((await client.patch(`/api/workspaces/${ws.workspaceId}/billing/members/${stranger.id}`, { limitUsd: 1 })).status).toBe(404)
  })

  it('members bill the workspace team inside the workspace their own key outside (LiteLLM in stub mode)', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    await seedSubscription(ws.workspaceId, { seats: 4, adminId: admin.id })
    await testDb().query('UPDATE workspace_members SET ai_limit_usd = 7 WHERE workspace_id = $1 AND user_id = $2', [ws.workspaceId, admin.id])
    const client = await loggedInClient(admin.id)

    const inside = await client.get(`/api/ai/credits?workspaceId=${ws.workspaceId}`)
    expect(inside.status).toBe(200)
    const body = await inside.json() as { attribution: string, plan: string, workspace: { teamBudgetUsd: number, memberLimitUsd: number | null } | null }
    expect(body.attribution).toBe('workspace')
    expect(body.plan).toBe('team')
    // Team default: $5 per seat.
    expect(body.workspace).toMatchObject({ teamBudgetUsd: 20, memberLimitUsd: 7 })
    const member = (await testDb().query('SELECT litellm_key_id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [ws.workspaceId, admin.id])).rows[0]
    expect(member?.litellm_key_id).toBeTruthy()

    const outside = await client.get('/api/ai/credits')
    expect((await outside.json() as { attribution: string, workspace: unknown }).attribution).toBe('user')
  })

  it('removing a member drops their workspace key', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const [memberId] = await addMembers(ws.workspaceId, 1)
    await seedSubscription(ws.workspaceId, { seats: 3, adminId: admin.id })
    const doc = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId })
    void doc
    const memberClient = await loggedInClient(memberId!)
    expect((await memberClient.get(`/api/ai/credits?workspaceId=${ws.workspaceId}`)).status).toBe(200)
    const removed = await (await loggedInClient(admin.id)).delete(`/api/workspaces/${ws.workspaceId}/members/${memberId}`)
    expect(removed.status).toBe(200)
    const rows = (await testDb().query('SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [ws.workspaceId, memberId])).rows
    expect(rows).toHaveLength(0)
  })
})

describe('workspace deletion with a subscription', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('cancels the subscription and removes the row with the workspace', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    await seedSubscription(ws.workspaceId, { seats: 3, adminId: admin.id })
    const res = await (await loggedInClient(admin.id)).delete(`/api/workspaces/${ws.workspaceId}`)
    expect(res.status).toBe(200)
    expect(await readSub(ws.workspaceId)).toBeUndefined()
    const audit = (await testDb().query(`SELECT action FROM audit_log WHERE scope = 'billing' AND scope_id = $1`, [ws.workspaceId])).rows
    expect(audit.map(r => r.action)).toContain('workspace.subscription_cancelled')
  })

  it('billing switched off with a running subscription: refused, nothing deleted', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const doc = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId })
    await seedSubscription(ws.workspaceId, { seats: 3, adminId: admin.id })
    const res = await (await loggedInClient(admin.id, undefined, TEST_BILLING_OFF_BASE_URL)).delete(`/api/workspaces/${ws.workspaceId}`)
    expect(res.status).toBe(409)
    expect((await res.json() as { data?: { code?: string } }).data?.code).toBe('billing/subscription-active')
    expect(await readSub(ws.workspaceId)).toBeDefined()
    expect((await testDb().query('SELECT 1 FROM documents WHERE doc_id = $1', [doc.docId])).rowCount).toBe(1)
  })

  it('an ended subscription doesn\'t hold up the deletion, even with billing off', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    await seedSubscription(ws.workspaceId, { seats: 3, adminId: admin.id, status: 'canceled' })
    const res = await (await loggedInClient(admin.id, undefined, TEST_BILLING_OFF_BASE_URL)).delete(`/api/workspaces/${ws.workspaceId}`)
    expect(res.status).toBe(200)
    expect(await readSub(ws.workspaceId)).toBeUndefined()
  })
})

describe('workspace plan in the surfaces that show it (WP6)', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('workspace list, doc token and the profile billing name the plan that covers a member', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const plain = await createWorkspace(admin.id)
    await seedSubscription(ws.workspaceId, { plan: 'business', adminId: admin.id })
    const [memberId] = await addMembers(ws.workspaceId, 1)
    const doc = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId })
    const member = await loggedInClient(memberId!)

    const list = await (await (await loggedInClient(admin.id)).get('/api/user/workspaces')).json() as Array<{ workspaceId: string, plan: string | null }>
    expect(list.find(w => w.workspaceId === ws.workspaceId)?.plan).toBe('business')
    expect(list.find(w => w.workspaceId === plain.workspaceId)?.plan).toBeNull()

    const token = await (await member.get(`/api/docs/${doc.docId}/token`)).json() as { workspacePlan: string | null }
    expect(token.workspacePlan).toBe('business')

    const billing = await (await member.get('/api/user/billing')).json() as { coveringWorkspaces: Array<{ workspaceId: string, plan: string }> }
    expect(billing.coveringWorkspaces).toEqual([{ workspaceId: ws.workspaceId, name: expect.any(String), plan: 'business' }])
  })

  it('a lapsed subscription covers nobody', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    await seedSubscription(ws.workspaceId, { status: 'canceled', adminId: admin.id })
    const doc = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId })
    const client = await loggedInClient(admin.id)
    expect((await (await client.get(`/api/docs/${doc.docId}/token`)).json() as { workspacePlan: unknown }).workspacePlan).toBeNull()
    expect((await (await client.get('/api/user/billing')).json() as { coveringWorkspaces: unknown[] }).coveringWorkspaces).toEqual([])
  })
})
