import { describe, it, expect, beforeEach } from 'vitest'
import jwt from 'jsonwebtoken'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import {
  createDoc,
  createUser,
  createWorkspace,
  setDocPasswordHash,
  setMemberRole
} from '../setup/fixtures'
import { TEST_JWT_SECRET } from '../setup/env'

// POST /api/docs/:docId/password — one endpoint, three actions:
//   action: 'set'     → owner / workspace admin, 4+ char password.
//   action: 'verify'  → public (rate-limited in prod), returns 2h JWT.
//   action: 'remove'  → owner / workspace admin, clears password + mode.
//
// The verify path is high-risk: it's the only way an anonymous caller
// trades knowledge of a password for a scoped JWT that unlocks private
// asset access. Tests target the correctness of *what's returned* (JWT
// shape + scope) and the negative cases (wrong password, wrong action).

// Pre-hashed "secret123" — nuxt-auth-utils scrypt format. Let fixtures
// inject this directly into the DB instead of hitting the SET action
// every time; cheap test setup + deterministic.
async function setupPasswordDoc(ownerId: number | null, passwordClear: string) {
  const doc = await createDoc({
    ownerId,
    accessMode: 'password-protected'
  })
  // Use the running Nuxt server to hash the password via the SET action.
  // Simpler than duplicating the scrypt call in the test harness and
  // guarantees we're always testing against the exact hash format the
  // app produces.
  if (ownerId !== null) {
    const owner = await (async () => {
      const db = testDb()
      const r = await db.query<{ name: string }>('SELECT name FROM users WHERE id = $1', [ownerId])
      return { id: ownerId, name: r.rows[0]?.name || 'Owner' }
    })()
    const client = await loggedInClient(owner.id, owner.name)
    const res = await client.post(`/api/docs/${doc.docId}/password`, {
      action: 'set',
      password: passwordClear
    })
    if (res.status !== 200) {
      throw new Error(`[setupPasswordDoc] SET failed ${res.status}: ${await res.text()}`)
    }
  }
  return doc
}

describe('POST /api/docs/:docId/password', () => {
  beforeEach(async () => {
    await resetDb()
  })

  describe('action: set', () => {
    it('owner can set a password', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id)
      const res = await client.post(`/api/docs/${doc.docId}/password`, {
        action: 'set',
        password: 'secret123'
      })
      expect(res.status).toBe(200)

      // Side effect: accessMode flipped to password-protected.
      const db = testDb()
      const r = await db.query<{ access_mode: string, password_hash: string | null }>(
        'SELECT access_mode, password_hash FROM documents WHERE doc_id = $1',
        [doc.docId]
      )
      expect(r.rows[0]?.access_mode).toBe('password-protected')
      expect(r.rows[0]?.password_hash).toBeTruthy()
    })

    it('non-owner cannot set (403)', async () => {
      const owner = await createUser()
      const other = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(other.id)
      const res = await client.post(`/api/docs/${doc.docId}/password`, {
        action: 'set',
        password: 'secret123'
      })
      expect(res.status).toBe(403)
    })

    it('workspace admin can set on a workspace doc', async () => {
      const creator = await createUser()
      const admin = await createUser()
      const ws = await createWorkspace(creator.id)
      await setMemberRole(ws.workspaceId, admin.id, 'admin')
      const doc = await createDoc({
        ownerId: creator.id,
        workspaceId: ws.workspaceId,
        accessMode: 'private'
      })
      const client = await loggedInClient(admin.id)
      const res = await client.post(`/api/docs/${doc.docId}/password`, {
        action: 'set',
        password: 'secret123'
      })
      expect(res.status).toBe(200)
    })

    it('workspace editor cannot set (403) — set is a manage action', async () => {
      // Regression guard: editors are allowed content edits but NOT
      // access-mode / password changes. canManageDoc must not confuse
      // "edit" with "manage".
      const creator = await createUser()
      const editor = await createUser()
      const ws = await createWorkspace(creator.id)
      await setMemberRole(ws.workspaceId, editor.id, 'editor')
      const doc = await createDoc({
        ownerId: creator.id,
        workspaceId: ws.workspaceId,
        accessMode: 'private'
      })
      const client = await loggedInClient(editor.id)
      const res = await client.post(`/api/docs/${doc.docId}/password`, {
        action: 'set',
        password: 'secret123'
      })
      expect(res.status).toBe(403)
    })

    it('rejects password shorter than 4 chars (400)', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id)
      const res = await client.post(`/api/docs/${doc.docId}/password`, {
        action: 'set',
        password: 'abc'
      })
      expect(res.status).toBe(400)
    })

    it('anonymous cannot set (401 from middleware? or 403 from handler)', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      // middleware whitelists POST on /password, so anon reaches the handler.
      // Handler calls requireValidatedUserSession for 'set' → 401.
      const res = await anonClient().post(`/api/docs/${doc.docId}/password`, {
        action: 'set',
        password: 'secret123'
      })
      expect(res.status).toBe(401)
    })
  })

  describe('action: verify', () => {
    it('correct password returns 2h JWT scoped to the doc', async () => {
      const owner = await createUser()
      const doc = await setupPasswordDoc(owner.id, 'secret123')
      const res = await anonClient().post(`/api/docs/${doc.docId}/password`, {
        action: 'verify',
        password: 'secret123'
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { token: string, readOnly: boolean }
      expect(body.token).toBeTruthy()
      expect(body.readOnly).toBe(false)
      const payload = jwt.verify(body.token, TEST_JWT_SECRET) as Record<string, unknown>
      expect(payload.docId).toBe(doc.docId)
      expect(payload.userId).toBe('anonymous')
      const exp = payload.exp as number
      const iat = payload.iat as number
      expect(exp - iat).toBe(2 * 60 * 60)
    })

    it('wrong password returns 401', async () => {
      const owner = await createUser()
      const doc = await setupPasswordDoc(owner.id, 'secret123')
      const res = await anonClient().post(`/api/docs/${doc.docId}/password`, {
        action: 'verify',
        password: 'wrong'
      })
      expect(res.status).toBe(401)
    })

    it('doc with no password hash returns 400', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
      // no passwordHash set
      const res = await anonClient().post(`/api/docs/${doc.docId}/password`, {
        action: 'verify',
        password: 'whatever'
      })
      expect(res.status).toBe(400)
    })

    it('JWT carries logged-in userName when verifier has a session', async () => {
      // Regression guard: a logged-in user who also passes the password
      // (e.g. a shared-secret doc they didn't create) should still get
      // their name in the JWT for attribution.
      const owner = await createUser()
      const verifier = await createUser({ name: 'Charlie' })
      const doc = await setupPasswordDoc(owner.id, 'pw123456')
      const client = await loggedInClient(verifier.id, 'Charlie')
      const res = await client.post(`/api/docs/${doc.docId}/password`, {
        action: 'verify',
        password: 'pw123456'
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { token: string }
      const payload = jwt.verify(body.token, TEST_JWT_SECRET) as Record<string, unknown>
      expect(payload.userId).toBe(verifier.id)
      expect(payload.userName).toBe('Charlie')
    })
  })

  describe('action: remove', () => {
    it('owner can remove and mode flips to open-edit', async () => {
      const owner = await createUser()
      const doc = await setupPasswordDoc(owner.id, 'secret123')
      const client = await loggedInClient(owner.id)
      const res = await client.post(`/api/docs/${doc.docId}/password`, {
        action: 'remove'
      })
      expect(res.status).toBe(200)

      const db = testDb()
      const r = await db.query<{ access_mode: string, password_hash: string | null }>(
        'SELECT access_mode, password_hash FROM documents WHERE doc_id = $1',
        [doc.docId]
      )
      expect(r.rows[0]?.access_mode).toBe('open-edit')
      expect(r.rows[0]?.password_hash).toBeNull()
    })

    it('non-owner cannot remove (403)', async () => {
      const owner = await createUser()
      const other = await createUser()
      const doc = await setupPasswordDoc(owner.id, 'secret123')
      const client = await loggedInClient(other.id)
      const res = await client.post(`/api/docs/${doc.docId}/password`, {
        action: 'remove'
      })
      expect(res.status).toBe(403)
    })

    it('anonymous cannot remove (401)', async () => {
      const owner = await createUser()
      const doc = await setupPasswordDoc(owner.id, 'secret123')
      const res = await anonClient().post(`/api/docs/${doc.docId}/password`, {
        action: 'remove'
      })
      expect(res.status).toBe(401)
    })
  })

  describe('general', () => {
    it('invalid action yields 400', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const res = await anonClient().post(`/api/docs/${doc.docId}/password`, {
        action: 'nuke',
        password: 'x'
      })
      expect(res.status).toBe(400)
    })

    it('missing doc yields 404 regardless of action', async () => {
      const res = await anonClient().post('/api/docs/missing-doc/password', {
        action: 'verify',
        password: 'x'
      })
      expect(res.status).toBe(404)
    })
  })
})
