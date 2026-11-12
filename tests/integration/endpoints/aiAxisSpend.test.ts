import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import { createUser } from '../setup/fixtures'
import { ALL_FEATURE_TAGS } from '../../../server/utils/litellm/featureTags'

// /admin/axis-spend: per-axis spend filter (workspace / user / doc).
// Companion to /admin/ai-spend (which gives the global feature
// breakdown). Used to answer "how much has THIS entity cost in the
// last N days, broken down by feature".

async function promoteToAdmin(userId: number): Promise<void> {
  await testDb().query('UPDATE users SET is_admin = true WHERE id = $1', [userId])
}

describe('GET /api/admin/axis-spend', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('401 when unauthenticated', async () => {
    const res = await anonClient().get('/api/admin/axis-spend?axis=workspace&value=ws-abc')
    expect(res.status).toBe(401)
  })

  it('403 for a non-admin user', async () => {
    const u = await createUser()
    const client = await loggedInClient(u.id)
    const res = await client.get('/api/admin/axis-spend?axis=workspace&value=ws-abc')
    expect(res.status).toBe(403)
  })

  it('400 when axis is missing or invalid', async () => {
    const u = await createUser()
    await promoteToAdmin(u.id)
    const client = await loggedInClient(u.id)

    const noAxis = await client.get('/api/admin/axis-spend?value=ws-abc')
    expect(noAxis.status).toBe(400)

    const badAxis = await client.get('/api/admin/axis-spend?axis=team&value=ws-abc')
    expect(badAxis.status).toBe(400)
  })

  it('400 when value is missing or oversize', async () => {
    const u = await createUser()
    await promoteToAdmin(u.id)
    const client = await loggedInClient(u.id)

    const noValue = await client.get('/api/admin/axis-spend?axis=workspace')
    expect(noValue.status).toBe(400)

    const huge = 'x'.repeat(100)
    const oversize = await client.get(`/api/admin/axis-spend?axis=workspace&value=${huge}`)
    expect(oversize.status).toBe(400)
  })

  it('returns the per-feature breakdown shape for a workspace axis query', async () => {
    const u = await createUser()
    await promoteToAdmin(u.id)
    const client = await loggedInClient(u.id)

    const res = await client.get('/api/admin/axis-spend?axis=workspace&value=ws-abc-123')
    expect(res.status).toBe(200)

    const body = await res.json() as {
      axis: string
      value: string
      from: string
      to: string
      totalSpendUsd: number
      totalRequests: number
      breakdown: Array<{ tag: string, spendUsd: number, requests: number, sharePct: number }>
    }

    expect(body.axis).toBe('workspace')
    expect(body.value).toBe('ws-abc-123')
    expect(body.from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(body.to).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    // Every canonical feature has a row, in canonical order.
    const tags = body.breakdown.map(r => r.tag)
    for (const expected of ALL_FEATURE_TAGS) {
      expect(tags).toContain(expected)
    }
  })

  it('accepts user + doc axes too', async () => {
    const u = await createUser()
    await promoteToAdmin(u.id)
    const client = await loggedInClient(u.id)

    const userRes = await client.get('/api/admin/axis-spend?axis=user&value=42')
    expect(userRes.status).toBe(200)
    expect((await userRes.json()).axis).toBe('user')

    const docRes = await client.get('/api/admin/axis-spend?axis=doc&value=doc-xyz')
    expect(docRes.status).toBe(200)
    expect((await docRes.json()).axis).toBe('doc')
  })
})
