import { describe, it, expect, beforeEach } from 'vitest'
import jwt from 'jsonwebtoken'
import { resetDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import { createDoc, createUser } from '../setup/fixtures'
import { TEST_JWT_SECRET } from '../setup/env'
import { mintSessionJwt } from '~~/shared/test-helpers/jwt'

// GET /api/docs/:docId/file-token — the image-access token for the live
// preview / print iframes, which run sandboxed in an opaque origin and so
// send no session cookie. Same gate as /api/files; the minted
// `file-access` token unlocks /api/files and NOTHING else.

const FILE_ID = 'abc12345XYZ0.png'

function mintDocJwt(docId: string): string {
  return mintSessionJwt({ docId, userId: 'anonymous', userName: null, readOnly: false }, { secret: TEST_JWT_SECRET })
}

describe('GET /api/docs/:docId/file-token', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('mints a short-lived file-access token for the owner of a private doc', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
    const client = await loggedInClient(owner.id)
    const res = await client.get(`/api/docs/${doc.docId}/file-token`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('no-store')
    const body = await res.json() as { token: string, expiresAt: number }
    const payload = jwt.verify(body.token, TEST_JWT_SECRET) as Record<string, unknown>
    expect(payload).toMatchObject({ docId: doc.docId, scope: 'file-access', readOnly: true })
    const ttl = body.expiresAt - Date.now()
    expect(ttl).toBeGreaterThan(14 * 60_000)
    expect(ttl).toBeLessThanOrEqual(15 * 60_000)

    // The token alone (no cookie — what the opaque-origin iframe sends) opens the image route.
    const img = await anonClient().get(`/api/files/${doc.docId}/${FILE_ID}?token=${encodeURIComponent(body.token)}`)
    expect(img.status).toBe(302)
    expect(img.headers.get('cross-origin-resource-policy')).toBe('cross-origin')
  })

  it('refuses callers who may not read the images', async () => {
    const owner = await createUser()
    const other = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
    expect((await anonClient().get(`/api/docs/${doc.docId}/file-token`)).status).toBe(403)
    expect((await (await loggedInClient(other.id)).get(`/api/docs/${doc.docId}/file-token`)).status).toBe(403)
    expect((await anonClient().get('/api/docs/does-not-exist/file-token')).status).toBe(404)
  })

  it('accepts a password visitor\'s doc JWT as Bearer', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'password-protected' })
    const res = await anonClient().get(`/api/docs/${doc.docId}/file-token`, {
      headers: { authorization: `Bearer ${mintDocJwt(doc.docId)}` }
    })
    expect(res.status).toBe(200)
  })

  it('scopes the token to /api/files of that document only', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
    const otherDoc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
    const client = await loggedInClient(owner.id)
    const { token } = await (await client.get(`/api/docs/${doc.docId}/file-token`)).json() as { token: string }
    const bearer = { headers: { authorization: `Bearer ${token}` } }

    // Not another document's images.
    expect((await anonClient().get(`/api/files/${otherDoc.docId}/${FILE_ID}?token=${encodeURIComponent(token)}`)).status).toBe(403)
    // Not the metadata / activity endpoints, which accept session-shaped doc JWTs.
    const meta = await (await anonClient().get(`/api/docs/${doc.docId}/meta`, bearer)).json() as Record<string, unknown>
    expect(meta.forbidden).toBe(true)
    expect(meta.title).toBeUndefined()
    expect((await anonClient().get(`/api/docs/${doc.docId}/activity`, bearer)).status).toBe(403)
    // And it can't mint its own successor.
    expect((await anonClient().get(`/api/docs/${doc.docId}/file-token`, bearer)).status).toBe(403)
  })

  it('other responses keep Cross-Origin-Resource-Policy: same-site', async () => {
    const res = await anonClient().get('/api/health')
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-site')
  })
})
