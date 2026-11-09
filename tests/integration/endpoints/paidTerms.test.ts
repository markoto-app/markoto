import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { loggedInClient } from '../setup/client'
import { createUser, createWorkspace } from '../setup/fixtures'

// Paid Plans Terms (WP6b): every purchase needs `acceptPaidTerms: true`
// (the ticked box at checkout), and each accepted purchase leaves a
// `policy.accepted` audit row naming the document, version and item.

const FUTURE = new Date(Date.now() + 30 * 24 * 3600 * 1000)

async function code(res: Response): Promise<string | undefined> {
  return (await res.json() as { data?: { code?: string } }).data?.code
}

async function acceptances(): Promise<Array<{ scope: string, scope_id: string, metadata: Record<string, unknown> }>> {
  return (await testDb().query(
    `SELECT scope, scope_id, metadata FROM audit_log WHERE action = 'policy.accepted' AND metadata->>'document' = 'paid-terms' ORDER BY id`
  )).rows
}

describe('Paid Plans Terms at checkout', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('refuses every purchase without the accepted box (400 billing/terms-required)', async () => {
    const u = await createUser()
    await testDb().query(`UPDATE users SET plan = 'pro', plan_valid_until = $2 WHERE id = $1`, [u.id, FUTURE])
    const ws = await createWorkspace(u.id)
    const client = await loggedInClient(u.id)

    for (const [path, body] of [
      ['/api/billing/checkout', { plan: 'pro', acceptPaidTerms: false }],
      ['/api/billing/topup', { pack: '10' }],
      [`/api/workspaces/${ws.workspaceId}/billing/checkout`, { plan: 'team', seats: 3, acceptPaidTerms: 'yes' }]
    ] as const) {
      const res = await client.post(path, body)
      expect(res.status, path).toBe(400)
      expect(await code(res), path).toBe('billing/terms-required')
    }
    expect(await acceptances()).toEqual([])
  })

  it('records the acceptance with the purchase', async () => {
    const u = await createUser()
    const ws = await createWorkspace(u.id)
    const client = await loggedInClient(u.id)

    expect((await client.post('/api/billing/checkout', { plan: 'pro', interval: 'year', acceptPaidTerms: true })).status).toBe(200)
    expect((await client.post(`/api/workspaces/${ws.workspaceId}/billing/checkout`, { plan: 'team', seats: 3, acceptPaidTerms: true })).status).toBe(200)

    const rows = await acceptances()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ scope: 'user', scope_id: String(u.id), metadata: { document: 'paid-terms', version: 1, purchase: 'plan', item: 'pro_year' } })
    expect(rows[1]).toMatchObject({ scope: 'workspace', scope_id: ws.workspaceId, metadata: { document: 'paid-terms', purchase: 'plan', item: 'team_month' } })
  })
})
