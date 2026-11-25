import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient, type TestClient } from '../setup/client'
import { createUser } from '../setup/fixtures'
import { createAnonDoc } from '../setup/anonGate'

// "Sign in to keep your documents": after signing in, POST /api/docs/adopt
// hands the anonymous documents this browser created (creator-key cookie)
// to the account. Sharing stays as it was, so a link already passed on
// keeps working.

async function newAnonDoc(client: TestClient, title: string): Promise<string> {
  const res = await createAnonDoc(client, { title })
  expect(res.status).toBe(200)
  return (await res.json() as { docId: string }).docId
}

function creatorCookie(client: TestClient): string {
  const pair = client.cookieHeader().split('; ').find(c => c.startsWith('markoto-anon-creator='))
  if (!pair) throw new Error('no creator cookie')
  return pair
}

async function owners(docIds: string[]): Promise<Record<string, number | null>> {
  const r = await testDb().query<{ doc_id: string, owner_id: number | null }>('SELECT doc_id, owner_id FROM documents WHERE doc_id = ANY($1)', [docIds])
  return Object.fromEntries(r.rows.map(row => [row.doc_id, row.owner_id]))
}

describe('POST /api/docs/adopt', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('makes this browser\'s anonymous documents the account\'s, once, keeping their links working', async () => {
    const browser = anonClient()
    const first = await newAnonDoc(browser, 'Trip notes')
    const second = await newAnonDoc(browser, 'Packing list')
    const gone = await newAnonDoc(browser, 'Deleted draft')
    expect((await browser.delete(`/api/docs/${gone}`)).status).toBe(200)
    const elsewhere = await newAnonDoc(anonClient(), 'Someone else')

    const user = await createUser()
    const signedIn = await loggedInClient(user.id)
    signedIn.setCookie(creatorCookie(browser))

    const res = await signedIn.post('/api/docs/adopt', {})
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ adopted: 2 })
    expect(await owners([first, second, elsewhere])).toEqual({ [first]: user.id, [second]: user.id, [elsewhere]: null })

    // The owner now manages it; the link still opens for everyone else.
    const asOwner = await (await signedIn.get(`/api/docs/${first}/token`)).json() as { ownerId: number, canDelete: boolean, accessMode: string }
    expect(asOwner).toMatchObject({ ownerId: user.id, canDelete: true, accessMode: 'open-edit' })
    const visitor = await (await anonClient().get(`/api/docs/${first}/token`)).json() as { token: string | null }
    expect(visitor.token).toBeTruthy()

    // In the owner's list.
    const mine = await (await signedIn.get('/api/user/documents')).json() as Array<{ docId: string }>
    expect(mine.map(d => d.docId).sort()).toEqual([first, second].sort())

    // Idempotent.
    expect(await (await signedIn.post('/api/docs/adopt', {})).json()).toEqual({ adopted: 0 })
    const audit = await testDb().query(`SELECT scope_id FROM audit_log WHERE action = 'doc.adopted'`)
    expect(audit.rows).toHaveLength(2)
  })

  it('takes nothing without the creator cookie, and needs a session', async () => {
    const browser = anonClient()
    const doc = await newAnonDoc(browser, 'Draft')
    const user = await createUser()
    const signedIn = await loggedInClient(user.id)
    expect(await (await signedIn.post('/api/docs/adopt', {})).json()).toEqual({ adopted: 0 })
    expect(await owners([doc])).toEqual({ [doc]: null })

    expect((await browser.post('/api/docs/adopt', {})).status).toBe(401)
  })

  it('works before the onboarding is finished (the documents were created under the terms accepted then)', async () => {
    const browser = anonClient()
    const doc = await newAnonDoc(browser, 'Draft')
    const user = await createUser({ freshOnboarding: true })
    const signedIn = await loggedInClient(user.id)
    signedIn.setCookie(creatorCookie(browser))
    const res = await signedIn.post('/api/docs/adopt', {})
    expect(res.status).toBe(200)
    expect(await owners([doc])).toEqual({ [doc]: user.id })
  })
})
