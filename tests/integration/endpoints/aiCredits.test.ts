import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import { createUser, createWorkspace, setMemberRole } from '../setup/fixtures'
import { DEFAULT_TIERS as TIERS } from '../../../shared/config/tiers'
import { dollarsToPoints } from '../../../shared/billing/aiPoints'

// GET /api/ai/credits — drives the AI Points UI. Two branches:
//   - self-bill (default) — points come from the caller's own
//     LiteLLM virtual key.
//   - (+) workspace — points come from the SPONSOR's key, since
//     that's whose budget actually pays for the call.
//
// The `litellm-test` proxy is brought up alongside the rest of the
// integration stack (Phase 7) so these tests exercise the real
// /key/info round-trip — the points returned reflect what the
// proxy will actually charge against on the next call.

describe('GET /api/ai/credits', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('401 when unauthenticated', async () => {
    const res = await anonClient().get('/api/ai/credits')
    expect(res.status).toBe(401)
  })

  it('returns the caller\'s own pool for a fresh free user (self-bill)', async () => {
    const u = await createUser()
    const client = await loggedInClient(u.id)
    const res = await client.get('/api/ai/credits')
    expect(res.status).toBe(200)
    const body = await res.json() as {
      pointsRemaining: number
      pointsTotal: number
      plan: string
      attribution: 'user' | 'workspace'
    }
    expect(body.plan).toBe('free')
    expect(body.attribution).toBe('user')
    // Fresh key: spend=0, max_budget=plan budget, so remaining ==
    // total. We compare against the dollar→points conversion of the
    // free-tier budget so this test stays correct if the budget
    // changes in tiers.ts.
    expect(body.pointsTotal).toBe(dollarsToPoints(TIERS.free.litellmBudgetUsd))
    expect(body.pointsRemaining).toBe(body.pointsTotal)
  })

  it('a workspaceId shows the caller\'s own pool (the (+) sponsorship is retired)', async () => {
    // Team billing (pooled workspace budgets) arrives in WP3; until then a
    // workspace context — even one with a leftover `(+)` row — shows the
    // member's own pool.
    const owner = await createUser()
    const member = await createUser()
    const db = testDb()
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
    await db.query(
      'UPDATE users SET plan = $1, plan_valid_until = $2, stripe_current_period_start = $3 WHERE id = $4',
      ['pro', future, past, owner.id]
    )
    const ws = await createWorkspace(owner.id)
    await setMemberRole(ws.workspaceId, member.id, 'editor')
    await db.query(
      'UPDATE workspaces SET ai_enabled = TRUE, billing_owner_id = $1 WHERE workspace_id = $2',
      [owner.id, ws.workspaceId]
    )

    const client = await loggedInClient(member.id)
    const res = await client.get(`/api/ai/credits?workspaceId=${encodeURIComponent(ws.workspaceId)}`)
    expect(res.status).toBe(200)
    const body = await res.json() as { plan: string, attribution: string, pointsTotal: number }
    expect(body.plan).toBe('free')
    expect(body.attribution).toBe('user')
    expect(body.pointsTotal).toBe(dollarsToPoints(TIERS.free.litellmBudgetUsd))
  })
})
