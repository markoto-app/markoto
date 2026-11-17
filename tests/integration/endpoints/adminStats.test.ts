import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import { createDoc, createUser } from '../setup/fixtures'

// /api/admin/stats/*: admin only, aggregates only (no names, no emails),
// and a signed-in request records the caller's active day.

const TABS = ['overview', 'users', 'content', 'ai', 'revenue', 'ops'] as const

async function admin() {
  const u = await createUser({ name: 'Stats Admin', email: 'stats-admin@test.local' })
  await testDb().query('UPDATE users SET is_admin = true WHERE id = $1', [u.id])
  return { user: u, client: await loggedInClient(u.id) }
}

describe('GET /api/admin/stats/*', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('refuses anonymous callers and non-admins', async () => {
    for (const tab of TABS) {
      expect((await anonClient().get(`/api/admin/stats/${tab}`)).status).toBe(401)
    }
    const u = await createUser()
    const client = await loggedInClient(u.id)
    for (const tab of TABS) {
      expect((await client.get(`/api/admin/stats/${tab}`)).status).toBe(403)
    }
  })

  it('answers every tab with aggregates that name nobody', async () => {
    const { client } = await admin()
    await createDoc()
    for (const tab of TABS) {
      const res = await client.get(`/api/admin/stats/${tab}?range=7`)
      expect(res.status, tab).toBe(200)
      const json = await res.json() as { window: { range: string } }
      const body = JSON.stringify(json)
      expect(body).not.toContain('stats-admin@test.local')
      expect(body).not.toContain('Stats Admin')
      expect(json.window.range).toBe('7')
    }
  })

  it('counts the admin as active today after a signed-in request', async () => {
    const { client, user } = await admin()
    const res = await client.get('/api/admin/stats/users?range=all')
    expect(res.status).toBe(200)
    const day = (await testDb().query<{ d: string }>('SELECT last_active_on::text AS d FROM users WHERE id = $1', [user.id])).rows[0]?.d
    expect(day).toBe(new Date().toISOString().slice(0, 10))
    const again = await (await client.get('/api/admin/stats/users?range=all&bucket=month')).json() as { active: { day: number }, window: { bucket: string } }
    expect(again.active.day).toBe(1)
    expect(again.window.bucket).toBe('month')
  })

  it('falls back to 30 days for an unknown range', async () => {
    const { client } = await admin()
    const res = await client.get('/api/admin/stats/ops?range=1000')
    expect(res.status).toBe(200)
    expect((await res.json() as { window: { range: string } }).window.range).toBe('30')
  })
})
