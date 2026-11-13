import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { loggedInClient, loggedInClientSignedInAt } from '../setup/client'
import { createUser } from '../setup/fixtures'

// Revocable sessions + recent sign-in for sensitive actions.
//
//   - "Log out everywhere" (POST /api/user/sessions/revoke) bumps the
//     user's session epoch: every cookie sealed before it stops working.
//   - An account-deletion request does the same for every OTHER session
//     (the requesting browser is re-sealed so it can still cancel).
//   - Account deletion, data-export requests and BYOK provider changes
//     need a sign-in from the last 12 hours, else 401
//     `auth/reauth-required`.

const THIRTEEN_HOURS_MS = 13 * 60 * 60 * 1000

async function errorCode(res: Response): Promise<string | undefined> {
  const body = await res.json() as { data?: { code?: string } }
  return body.data?.code
}

describe('POST /api/user/sessions/revoke (log out everywhere)', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('invalidates every session of the user, including the caller', async () => {
    const user = await createUser()
    const laptop = await loggedInClient(user.id)
    const phone = await loggedInClient(user.id)
    expect((await phone.get('/api/user/workspaces')).status).toBe(200)

    const res = await laptop.post('/api/user/sessions/revoke')
    expect(res.status).toBe(200)

    // A cookie sealed before the bump, e.g. a stolen copy, is dead.
    expect((await phone.get('/api/user/workspaces')).status).toBe(401)
    expect((await laptop.get('/api/user/workspaces')).status).toBe(401)
    // A fresh sign-in works again.
    expect((await (await loggedInClient(user.id)).get('/api/user/workspaces')).status).toBe(200)
  })

  it('does not affect other users', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const bobClient = await loggedInClient(bob.id)
    await (await loggedInClient(alice.id)).post('/api/user/sessions/revoke')
    expect((await bobClient.get('/api/user/workspaces')).status).toBe(200)
  })

  it('records an audit row', async () => {
    const user = await createUser()
    await (await loggedInClient(user.id)).post('/api/user/sessions/revoke')
    const rows = await testDb().query<{ action: string }>(
      `SELECT action FROM audit_log WHERE scope = 'user' AND scope_id = $1`,
      [String(user.id)]
    )
    expect(rows.rows.map(r => r.action)).toContain('account.sessions_revoked')
  })
})

describe('account-deletion request', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('needs a recent sign-in (401 auth/reauth-required otherwise)', async () => {
    const user = await createUser()
    const stale = await loggedInClientSignedInAt(user.id, Date.now() - THIRTEEN_HOURS_MS)
    const res = await stale.post('/api/user/delete')
    expect(res.status).toBe(401)
    expect(await errorCode(res)).toBe('auth/reauth-required')
    const row = await testDb().query<{ deletion_requested_at: Date | null }>(
      'SELECT deletion_requested_at FROM users WHERE id = $1',
      [user.id]
    )
    expect(row.rows[0]?.deletion_requested_at).toBeNull()
  })

  it('signs out every other session but keeps the requesting browser signed in', async () => {
    const user = await createUser()
    const other = await loggedInClient(user.id)
    const requester = await loggedInClient(user.id)
    const res = await requester.post('/api/user/delete')
    expect(res.status).toBe(200)

    expect((await other.get('/api/user/account-status')).status).toBe(401)
    // The requester can still see the grace banner and cancel.
    expect((await requester.get('/api/user/account-status')).status).toBe(200)
    expect((await requester.post('/api/user/delete-cancel')).status).toBe(200)
  })
})

describe('recent sign-in for export + BYOK changes', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('data-export request: stale sign-in → 401, fresh → accepted', async () => {
    const user = await createUser()
    const stale = await loggedInClientSignedInAt(user.id, Date.now() - THIRTEEN_HOURS_MS)
    const res = await stale.post('/api/user/export')
    expect(res.status).toBe(401)
    expect(await errorCode(res)).toBe('auth/reauth-required')

    const fresh = await loggedInClient(user.id)
    expect((await fresh.post('/api/user/export')).status).toBeLessThan(300)
  })

  it('BYOK provider save / delete: stale sign-in → 401', async () => {
    const user = await createUser()
    const stale = await loggedInClientSignedInAt(user.id, Date.now() - THIRTEEN_HOURS_MS)
    const put = await stale.put('/api/user/ai-providers/chat', {
      baseUrl: 'https://api.example.com/v1',
      model: 'x',
      apiKey: 'sk-test-0000000000'
    })
    expect(put.status).toBe(401)
    expect(await errorCode(put)).toBe('auth/reauth-required')
    const del = await stale.delete('/api/user/ai-providers/chat')
    expect(del.status).toBe(401)
    expect(await errorCode(del)).toBe('auth/reauth-required')
  })

  it('a stale sign-in still works for ordinary requests', async () => {
    const user = await createUser()
    const stale = await loggedInClientSignedInAt(user.id, Date.now() - THIRTEEN_HOURS_MS)
    expect((await stale.get('/api/user/workspaces')).status).toBe(200)
  })
})
