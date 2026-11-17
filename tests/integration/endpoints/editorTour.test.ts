import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import { createUser } from '../setup/fixtures'

// The editor's first-run tour shows once per account: finishing or skipping
// it is stored on the user (POST /api/user/editor-tour) and read back from
// the account status, so a new session (sign-out clears localStorage) or
// another browser doesn't show it again.

async function tourDone(client: Awaited<ReturnType<typeof loggedInClient>>): Promise<boolean> {
  const res = await client.get('/api/user/account-status')
  expect(res.status).toBe(200)
  return (await res.json() as { editorTourDone: boolean }).editorTourDone
}

describe('editor tour, once per account', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('a new account has not seen it', async () => {
    const u = await createUser()
    expect(await tourDone(await loggedInClient(u.id))).toBe(false)
  })

  it('done in one session stays done in every later session', async () => {
    const u = await createUser()
    const first = await loggedInClient(u.id)
    expect((await first.post('/api/user/editor-tour')).status).toBe(200)

    const later = await loggedInClient(u.id)
    expect(await tourDone(later)).toBe(true)
  })

  it('a second call keeps the first time', async () => {
    const u = await createUser()
    const client = await loggedInClient(u.id)
    await client.post('/api/user/editor-tour')
    const first = (await testDb().query('SELECT editor_tour_done_at FROM users WHERE id = $1', [u.id])).rows[0].editor_tour_done_at
    await client.post('/api/user/editor-tour')
    const second = (await testDb().query('SELECT editor_tour_done_at FROM users WHERE id = $1', [u.id])).rows[0].editor_tour_done_at
    expect(second).toEqual(first)
  })

  it('needs a session', async () => {
    expect((await anonClient().post('/api/user/editor-tour')).status).toBe(401)
  })
})
