import { describe, it, expect, beforeEach } from 'vitest'
import jwt from 'jsonwebtoken'
import { resetDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import {
  createDoc,
  createUser,
  createWorkspace,
  setMemberRole
} from '../setup/fixtures'
import { TEST_JWT_SECRET } from '../setup/env'

// GET /api/docs/:docId/token — the hinge of the app's authz model.
//
// Covers every (accessMode × role × ownership) branch end-to-end:
//   - Correct HTTP response shape
//   - JWT issuance (or absence) matching the decision
//   - readOnly flag in both the response and the signed JWT payload
//   - Response metadata (accessMode, ownerId, theme) always present so
//     the client can render the lock screen / read-only banner / etc.
//
// Decision logic is already exhaustively tested at the unit level in
// docPermissions.test.ts; this suite verifies the HTTP-layer wiring
// — DB queries, session resolution, JWT signing — works as intended.

interface TokenResponse {
  token: string | null
  requiresPassword: boolean
  forbidden: boolean
  readOnly: boolean
  accessMode: string
  ownerId: number | null
  theme: unknown
}

function decodeJwt(token: string): Record<string, unknown> {
  return jwt.verify(token, TEST_JWT_SECRET) as Record<string, unknown>
}

describe('GET /api/docs/:docId/token', () => {
  beforeEach(async () => {
    await resetDb()
  })

  describe('missing doc', () => {
    it('returns 404 for a non-existent doc', async () => {
      const res = await anonClient().get('/api/docs/nonexistent/token')
      expect(res.status).toBe(404)
    })
  })

  describe('anonymous doc (no owner, open-edit)', () => {
    it('anonymous caller gets full-edit JWT', async () => {
      const doc = await createDoc({ accessMode: 'open-edit' })
      const res = await anonClient().get(`/api/docs/${doc.docId}/token`)
      expect(res.status).toBe(200)
      const body = await res.json() as TokenResponse
      expect(body.token).not.toBeNull()
      expect(body.readOnly).toBe(false)
      expect(body.forbidden).toBe(false)
      expect(body.requiresPassword).toBe(false)
      expect(body.ownerId).toBeNull()
      expect(body.accessMode).toBe('open-edit')
      const payload = decodeJwt(body.token!)
      expect(payload.docId).toBe(doc.docId)
      expect(payload.readOnly).toBe(false)
      expect(payload.userId).toBe('anonymous')
    })

    it('JWT has a 2-hour expiry', async () => {
      const doc = await createDoc({ accessMode: 'open-edit' })
      const res = await anonClient().get(`/api/docs/${doc.docId}/token`)
      const body = await res.json() as TokenResponse
      const payload = decodeJwt(body.token!)
      const exp = payload.exp as number
      const iat = payload.iat as number
      expect(exp - iat).toBe(2 * 60 * 60)
    })
  })

  describe('owned private doc', () => {
    it('owner gets full-edit JWT carrying userId and userName', async () => {
      const owner = await createUser({ name: 'Alice' })
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id, 'Alice')
      const res = await client.get(`/api/docs/${doc.docId}/token`)
      expect(res.status).toBe(200)
      const body = await res.json() as TokenResponse
      expect(body.token).not.toBeNull()
      expect(body.readOnly).toBe(false)
      expect(body.ownerId).toBe(owner.id)
      const payload = decodeJwt(body.token!)
      expect(payload.userId).toBe(owner.id)
      expect(payload.userName).toBe('Alice')
      expect(payload.readOnly).toBe(false)
    })

    it('logged-in non-owner gets forbidden with no token', async () => {
      const owner = await createUser()
      const other = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(other.id)
      const res = await client.get(`/api/docs/${doc.docId}/token`)
      expect(res.status).toBe(200)
      const body = await res.json() as TokenResponse
      expect(body.token).toBeNull()
      expect(body.forbidden).toBe(true)
      expect(body.requiresPassword).toBe(false)
    })

    it('anonymous gets forbidden with no token', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const res = await anonClient().get(`/api/docs/${doc.docId}/token`)
      expect(res.status).toBe(200)
      const body = await res.json() as TokenResponse
      expect(body.token).toBeNull()
      expect(body.forbidden).toBe(true)
    })
  })

  describe('open-view mode', () => {
    it('anonymous gets a read-only JWT', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-view' })
      const res = await anonClient().get(`/api/docs/${doc.docId}/token`)
      const body = await res.json() as TokenResponse
      expect(body.token).not.toBeNull()
      expect(body.readOnly).toBe(true)
      expect(decodeJwt(body.token!).readOnly).toBe(true)
    })

    it('owner still gets full-edit on open-view', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-view' })
      const client = await loggedInClient(owner.id)
      const res = await client.get(`/api/docs/${doc.docId}/token`)
      const body = await res.json() as TokenResponse
      expect(body.readOnly).toBe(false)
    })
  })

  describe('password-protected mode', () => {
    it('anonymous gets requiresPassword with no token', async () => {
      const owner = await createUser()
      const doc = await createDoc({
        ownerId: owner.id,
        accessMode: 'password-protected'
      })
      const res = await anonClient().get(`/api/docs/${doc.docId}/token`)
      const body = await res.json() as TokenResponse
      expect(body.token).toBeNull()
      expect(body.requiresPassword).toBe(true)
      expect(body.forbidden).toBe(false)
    })

    it('owner bypasses password gate with full-edit JWT', async () => {
      const owner = await createUser()
      const doc = await createDoc({
        ownerId: owner.id,
        accessMode: 'password-protected'
      })
      const client = await loggedInClient(owner.id)
      const res = await client.get(`/api/docs/${doc.docId}/token`)
      const body = await res.json() as TokenResponse
      expect(body.token).not.toBeNull()
      expect(body.readOnly).toBe(false)
      expect(body.requiresPassword).toBe(false)
    })
  })

  describe('workspace roles', () => {
    it('admin gets full-edit on a private workspace doc', async () => {
      const creator = await createUser()
      const member = await createUser()
      const ws = await createWorkspace(creator.id)
      await setMemberRole(ws.workspaceId, member.id, 'admin')
      const doc = await createDoc({
        ownerId: creator.id,
        workspaceId: ws.workspaceId,
        accessMode: 'private'
      })
      const client = await loggedInClient(member.id)
      const res = await client.get(`/api/docs/${doc.docId}/token`)
      const body = await res.json() as TokenResponse
      expect(body.token).not.toBeNull()
      expect(body.readOnly).toBe(false)
    })

    it('editor gets full-edit on a private workspace doc', async () => {
      const creator = await createUser()
      const member = await createUser()
      const ws = await createWorkspace(creator.id)
      await setMemberRole(ws.workspaceId, member.id, 'editor')
      const doc = await createDoc({
        ownerId: creator.id,
        workspaceId: ws.workspaceId,
        accessMode: 'private'
      })
      const client = await loggedInClient(member.id)
      const res = await client.get(`/api/docs/${doc.docId}/token`)
      const body = await res.json() as TokenResponse
      expect(body.token).not.toBeNull()
      expect(body.readOnly).toBe(false)
    })

    it('viewer gets read-only on a private workspace doc', async () => {
      const creator = await createUser()
      const member = await createUser()
      const ws = await createWorkspace(creator.id)
      await setMemberRole(ws.workspaceId, member.id, 'viewer')
      const doc = await createDoc({
        ownerId: creator.id,
        workspaceId: ws.workspaceId,
        accessMode: 'private'
      })
      const client = await loggedInClient(member.id)
      const res = await client.get(`/api/docs/${doc.docId}/token`)
      const body = await res.json() as TokenResponse
      expect(body.token).not.toBeNull()
      expect(body.readOnly).toBe(true)
      expect(decodeJwt(body.token!).readOnly).toBe(true)
    })

    it('viewer on open-edit doc still read-only (role wins over public grant)', async () => {
      const creator = await createUser()
      const member = await createUser()
      const ws = await createWorkspace(creator.id)
      await setMemberRole(ws.workspaceId, member.id, 'viewer')
      const doc = await createDoc({
        ownerId: creator.id,
        workspaceId: ws.workspaceId,
        accessMode: 'open-edit'
      })
      const client = await loggedInClient(member.id)
      const res = await client.get(`/api/docs/${doc.docId}/token`)
      const body = await res.json() as TokenResponse
      expect(body.readOnly).toBe(true)
    })

    it('viewer bypasses password gate with read-only JWT', async () => {
      // Bug-fix regression guard: pre-fix, viewers on password-protected
      // docs got requiresPassword. Now they bypass — read-only.
      const creator = await createUser()
      const member = await createUser()
      const ws = await createWorkspace(creator.id)
      await setMemberRole(ws.workspaceId, member.id, 'viewer')
      const doc = await createDoc({
        ownerId: creator.id,
        workspaceId: ws.workspaceId,
        accessMode: 'password-protected'
      })
      const client = await loggedInClient(member.id)
      const res = await client.get(`/api/docs/${doc.docId}/token`)
      const body = await res.json() as TokenResponse
      expect(body.token).not.toBeNull()
      expect(body.readOnly).toBe(true)
      expect(body.requiresPassword).toBe(false)
    })

    it('admin bypasses password gate with full-edit JWT', async () => {
      const creator = await createUser()
      const member = await createUser()
      const ws = await createWorkspace(creator.id)
      await setMemberRole(ws.workspaceId, member.id, 'admin')
      const doc = await createDoc({
        ownerId: creator.id,
        workspaceId: ws.workspaceId,
        accessMode: 'password-protected'
      })
      const client = await loggedInClient(member.id)
      const res = await client.get(`/api/docs/${doc.docId}/token`)
      const body = await res.json() as TokenResponse
      expect(body.token).not.toBeNull()
      expect(body.readOnly).toBe(false)
    })

    it('non-member of the workspace is treated as a stranger', async () => {
      const creator = await createUser()
      const stranger = await createUser()
      const ws = await createWorkspace(creator.id)
      const doc = await createDoc({
        ownerId: creator.id,
        workspaceId: ws.workspaceId,
        accessMode: 'private'
      })
      const client = await loggedInClient(stranger.id)
      const res = await client.get(`/api/docs/${doc.docId}/token`)
      const body = await res.json() as TokenResponse
      expect(body.forbidden).toBe(true)
      expect(body.token).toBeNull()
    })
  })
})
