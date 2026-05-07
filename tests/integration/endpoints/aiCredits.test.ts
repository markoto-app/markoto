import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import { createUser, createWorkspace, setMemberRole } from '../setup/fixtures'
import { TIERS } from '../../../shared/config/tiers'
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

  it('reflects the SPONSOR\'s pool when (+) is active for the workspace', async () => {
    // Setup: sponsor on Max with plan_valid_until in the future +
    // stripe_current_period_start in the past so the resolver treats
    // the plan as active. Member is Free; without (+) they'd see
    // free-tier points.
    const sponsor = await createUser()
    const member = await createUser()
    const db = testDb()
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
    await db.query(
      'UPDATE users SET plan = $1, plan_valid_until = $2, stripe_current_period_start = $3 WHERE id = $4',
      ['max', future, past, sponsor.id]
    )
    const ws = await createWorkspace(sponsor.id)
    await setMemberRole(ws.workspaceId, member.id, 'editor')
    // Turn (+) on for this workspace and pin the sponsor as billing owner.
    await db.query(
      'UPDATE workspaces SET ai_enabled = TRUE, billing_owner_id = $1 WHERE workspace_id = $2',
      [sponsor.id, ws.workspaceId]
    )

    const client = await loggedInClient(member.id)
    // Pass workspaceId so the resolver enters the `(+)` branch.
    const res = await client.get(`/api/ai/credits?workspaceId=${encodeURIComponent(ws.workspaceId)}`)
    expect(res.status).toBe(200)
    const body = await res.json() as {
      pointsRemaining: number
      pointsTotal: number
      plan: string
      attribution: 'user' | 'workspace'
    }
    expect(body.plan).toBe('max')
    expect(body.attribution).toBe('workspace')
    // Member is Free, but the surfaced pool is Max — proves the
    // `billingUserId` re-routing went through.
    expect(body.pointsTotal).toBe(dollarsToPoints(TIERS.max.litellmBudgetUsd))
    expect(body.pointsRemaining).toBe(body.pointsTotal)
  })

  it('falls back to self-bill when the sponsor\'s plan has lapsed', async () => {
    // Sponsor plan expired yesterday — the resolver collapses (+) and
    // the member sees their own free-tier pool, NOT a stale sponsor pool.
    const sponsor = await createUser()
    const member = await createUser()
    const db = testDb()
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000)
    await db.query(
      'UPDATE users SET plan = $1, plan_valid_until = $2 WHERE id = $3',
      ['max', past, sponsor.id]
    )
    const ws = await createWorkspace(sponsor.id)
    await setMemberRole(ws.workspaceId, member.id, 'editor')
    await db.query(
      'UPDATE workspaces SET ai_enabled = TRUE, billing_owner_id = $1 WHERE workspace_id = $2',
      [sponsor.id, ws.workspaceId]
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
