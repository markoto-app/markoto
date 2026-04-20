import { describe, it, expect, beforeEach } from 'vitest'
import jwt from 'jsonwebtoken'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import {
  createDoc,
  createUser,
  createWorkspace,
  setMemberRole
} from '../setup/fixtures'
import { TEST_JWT_SECRET } from '../setup/env'

// GET /api/docs/:docId/activity — returns up to 50 edit/join/leave entries.
// Bug-fix regression target: pre-fix the endpoint had NO auth check.

async function seedActivity(docId: string): Promise<void> {
  const db = testDb()
  // Three entries so list semantics (ordering, limit) are observable.
  await db.query(
    `INSERT INTO activity_log (doc_id, user_name, action, word_count)
     VALUES ($1, 'Alice', 'edit', 10),
            ($1, 'Alice', 'edit', 20),
            ($1, 'Bob',   'join', NULL)`,
    [docId]
  )
}

function mintDocJwt(docId: string): string {
  return jwt.sign(
    { docId, userId: 'anonymous', readOnly: false },
    TEST_JWT_SECRET,
    { expiresIn: '2h' }
  )
}

describe('GET /api/docs/:docId/activity', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns 404 for a nonexistent doc', async () => {
    const res = await anonClient().get('/api/docs/nonexistent/activity')
    expect(res.status).toBe(404)
  })

  it('anonymous sees activity on open-edit doc', async () => {
    const doc = await createDoc({ accessMode: 'open-edit' })
    await seedActivity(doc.docId)
    const res = await anonClient().get(`/api/docs/${doc.docId}/activity`)
    expect(res.status).toBe(200)
    const entries = await res.json() as Array<{ action: string }>
    expect(entries).toHaveLength(3)
  })

  it('anonymous sees activity on open-view doc', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-view' })
    await seedActivity(doc.docId)
    const res = await anonClient().get(`/api/docs/${doc.docId}/activity`)
    expect(res.status).toBe(200)
  })

  describe('private mode (regression guard for pre-fix open activity)', () => {
    it('anonymous is denied', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      await seedActivity(doc.docId)
      const res = await anonClient().get(`/api/docs/${doc.docId}/activity`)
      expect(res.status).toBe(403)
    })

    it('logged-in non-owner is denied', async () => {
      const owner = await createUser()
      const other = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      await seedActivity(doc.docId)
      const client = await loggedInClient(other.id)
      const res = await client.get(`/api/docs/${doc.docId}/activity`)
      expect(res.status).toBe(403)
    })

    it('owner can read', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      await seedActivity(doc.docId)
      const client = await loggedInClient(owner.id)
      const res = await client.get(`/api/docs/${doc.docId}/activity`)
      expect(res.status).toBe(200)
    })

    it.each(['admin', 'editor', 'viewer'] as const)('workspace %s can read', async (role) => {
      const creator = await createUser()
      const member = await createUser()
      const ws = await createWorkspace(creator.id)
      await setMemberRole(ws.workspaceId, member.id, role)
      const doc = await createDoc({
        ownerId: creator.id,
        workspaceId: ws.workspaceId,
        accessMode: 'private'
      })
      await seedActivity(doc.docId)
      const client = await loggedInClient(member.id)
      const res = await client.get(`/api/docs/${doc.docId}/activity`)
      expect(res.status).toBe(200)
    })

    it('anonymous with valid doc JWT is allowed', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      await seedActivity(doc.docId)
      const token = mintDocJwt(doc.docId)
      const res = await anonClient().get(`/api/docs/${doc.docId}/activity`, {
        headers: { authorization: `Bearer ${token}` }
      })
      expect(res.status).toBe(200)
    })

    it('anonymous with JWT for a different doc is denied', async () => {
      const owner = await createUser()
      const target = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const decoy = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
      const token = mintDocJwt(decoy.docId)
      const res = await anonClient().get(`/api/docs/${target.docId}/activity`, {
        headers: { authorization: `Bearer ${token}` }
      })
      expect(res.status).toBe(403)
    })
  })

  describe('password-protected mode', () => {
    it('anonymous without JWT is denied', async () => {
      const owner = await createUser()
      const doc = await createDoc({
        ownerId: owner.id,
        accessMode: 'password-protected'
      })
      await seedActivity(doc.docId)
      const res = await anonClient().get(`/api/docs/${doc.docId}/activity`)
      expect(res.status).toBe(403)
    })

    it('anonymous with valid doc JWT is allowed', async () => {
      const owner = await createUser()
      const doc = await createDoc({
        ownerId: owner.id,
        accessMode: 'password-protected'
      })
      await seedActivity(doc.docId)
      const token = mintDocJwt(doc.docId)
      const res = await anonClient().get(`/api/docs/${doc.docId}/activity?token=${token}`)
      expect(res.status).toBe(200)
    })

    it('workspace member bypasses password even without JWT', async () => {
      const creator = await createUser()
      const member = await createUser()
      const ws = await createWorkspace(creator.id)
      await setMemberRole(ws.workspaceId, member.id, 'viewer')
      const doc = await createDoc({
        ownerId: creator.id,
        workspaceId: ws.workspaceId,
        accessMode: 'password-protected'
      })
      await seedActivity(doc.docId)
      const client = await loggedInClient(member.id)
      const res = await client.get(`/api/docs/${doc.docId}/activity`)
      expect(res.status).toBe(200)
    })
  })
})
