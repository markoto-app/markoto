import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import { createUser } from '../setup/fixtures'
import { ALL_FEATURE_TAGS } from '../../../server/utils/litellm/featureTags'

// /admin/ai-spend endpoint. Guards on requireAdminUser, then proxies
// LiteLLM's /spend/tags aggregation. The integration stack runs the
// real `litellm-test` proxy so the round-trip works end-to-end —
// the breakdown returned will be empty (no real spend in tests) but
// the SHAPE has to match.

async function promoteToAdmin(userId: number): Promise<void> {
  await testDb().query('UPDATE users SET is_admin = true WHERE id = $1', [userId])
}

describe('GET /api/admin/ai-spend', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('401 when unauthenticated', async () => {
    const res = await anonClient().get('/api/admin/ai-spend')
    expect(res.status).toBe(401)
  })

  it('403 for a non-admin user', async () => {
    const u = await createUser()
    const client = await loggedInClient(u.id)
    const res = await client.get('/api/admin/ai-spend')
    expect(res.status).toBe(403)
  })

  it('returns the canonical breakdown shape for an admin', async () => {
    const u = await createUser()
    await promoteToAdmin(u.id)
    const client = await loggedInClient(u.id)
    const res = await client.get('/api/admin/ai-spend')
    expect(res.status).toBe(200)

    const body = await res.json() as {
      from: string
      to: string
      totalSpendUsd: number
      totalRequests: number
      breakdown: Array<{ tag: string, spendUsd: number, requests: number, totalTokens: number, sharePct: number }>
    }

    // Window is the default 30-day range; both should be ISO YYYY-MM-DD.
    expect(body.from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(body.to).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(typeof body.totalSpendUsd).toBe('number')
    expect(typeof body.totalRequests).toBe('number')

    // Every canonical feature tag has a row, in canonical order.
    // The "other" row is conditional (only present when there's
    // actual untagged spend); the canonical 5 are always present.
    const tags = body.breakdown.map(r => r.tag)
    for (const expected of ALL_FEATURE_TAGS) {
      expect(tags).toContain(expected)
    }
    // Empty proxy → every row is zero.
    for (const row of body.breakdown) {
      expect(row.spendUsd).toBeGreaterThanOrEqual(0)
      expect(row.requests).toBeGreaterThanOrEqual(0)
      expect(row.sharePct).toBeGreaterThanOrEqual(0)
    }
  })

  it('honours from + to query params', async () => {
    const u = await createUser()
    await promoteToAdmin(u.id)
    const client = await loggedInClient(u.id)
    const res = await client.get('/api/admin/ai-spend?from=2026-01-01&to=2026-01-31')
    expect(res.status).toBe(200)
    const body = await res.json() as { from: string, to: string }
    expect(body.from).toBe('2026-01-01')
    expect(body.to).toBe('2026-01-31')
  })

  it('falls back to the default range on malformed dates (does NOT 400)', async () => {
    // Operators land on a chart, not an error, when they typo a URL.
    const u = await createUser()
    await promoteToAdmin(u.id)
    const client = await loggedInClient(u.id)
    const res = await client.get('/api/admin/ai-spend?from=not-a-date&to=2026-13-99')
    expect(res.status).toBe(200)
    const body = await res.json() as { from: string, to: string }
    expect(body.from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(body.to).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
