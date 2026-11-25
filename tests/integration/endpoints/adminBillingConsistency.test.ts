import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import { createUser } from '../setup/fixtures'

// /api/admin/billing-consistency: admin only, read-only, ids only.

describe('GET /api/admin/billing-consistency', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('refuses anonymous callers and non-admins', async () => {
    expect((await anonClient().get('/api/admin/billing-consistency')).status).toBe(401)
    const u = await createUser()
    expect((await (await loggedInClient(u.id)).get('/api/admin/billing-consistency')).status).toBe(403)
  })

  it('answers an admin with the comparison and names nobody', async () => {
    const admin = await createUser({ name: 'Billing Admin', email: 'billing-admin@test.local' })
    await testDb().query('UPDATE users SET is_admin = true WHERE id = $1', [admin.id])
    const res = await (await loggedInClient(admin.id)).get('/api/admin/billing-consistency')
    expect(res.status).toBe(200)
    const json = await res.json() as { billingEnabled: boolean, report: { stripeLive: number, trackedLive: { users: number, workspaces: number }, mismatches: unknown[] } | null }
    // The suite's server runs with billing on against stripe-mock.
    expect(json.billingEnabled).toBe(true)
    expect(json.report).toMatchObject({ trackedLive: { users: 0, workspaces: 0 } })
    expect(Array.isArray(json.report?.mismatches)).toBe(true)
    const body = JSON.stringify(json)
    expect(body).not.toContain('billing-admin@test.local')
    expect(body).not.toContain('Billing Admin')
  })
})
