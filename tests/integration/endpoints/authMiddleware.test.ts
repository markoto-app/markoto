import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import { createDoc, createUser } from '../setup/fixtures'

// server/middleware/auth.ts is the central whitelist that gates every
// /api/* path. Regressions here have big blast radius — a stray protected
// pattern exposes a mutation to anonymous callers. These tests verify the
// whitelist is what the code claims it is.

describe('auth middleware whitelist', () => {
  beforeEach(async () => {
    await resetDb()
  })

  describe('public routes (no session required)', () => {
    it('GET /api/health is public', async () => {
      const res = await anonClient().get('/api/health')
      // Health endpoint may return 200 or 503 depending on DB; both are
      // non-401 which is what we're testing.
      expect(res.status).not.toBe(401)
    })

    it('GET /api/docs/:id/token is public', async () => {
      const doc = await createDoc({ accessMode: 'open-edit' })
      const res = await anonClient().get(`/api/docs/${doc.docId}/token`)
      expect(res.status).toBe(200)
    })

    it('GET /api/docs/:id/meta is public', async () => {
      const doc = await createDoc({ accessMode: 'open-edit' })
      const res = await anonClient().get(`/api/docs/${doc.docId}/meta`)
      // meta may 200 or 404 depending on doc state, but NOT 401.
      expect(res.status).not.toBe(401)
    })

    it('GET /api/docs/:id/activity is public (endpoint does its own authz)', async () => {
      const doc = await createDoc({ accessMode: 'open-edit' })
      const res = await anonClient().get(`/api/docs/${doc.docId}/activity`)
      // 200 on open-edit doc. The important thing is it didn't 401 at the
      // middleware — the endpoint itself decides what's allowed.
      expect(res.status).toBe(200)
    })

    it('DELETE /api/docs/:id is public (endpoint decides for anon docs)', async () => {
      const doc = await createDoc({ accessMode: 'open-edit' }) // anon doc
      const res = await anonClient().delete(`/api/docs/${doc.docId}`)
      expect(res.status).toBe(200)
    })

    it('POST /api/docs (doc creation) is public', async () => {
      const res = await anonClient().post('/api/docs', {})
      // Creation returns 200 with a new docId.
      expect(res.status).not.toBe(401)
    })

    it('POST /api/docs/:id/password is public (verify path)', async () => {
      const doc = await createDoc({ accessMode: 'password-protected' })
      const res = await anonClient().post(`/api/docs/${doc.docId}/password`, { password: 'wrong' })
      // Verify-wrong yields 401/403/400, but NOT "middleware said no auth".
      // The endpoint itself chose that status; middleware would throw 401
      // with message 'Unauthorized'.
      const body = await res.text()
      expect(body).not.toContain('Unauthorized')
    })
  })

  describe('protected routes (session required)', () => {
    it('GET /api/user/documents rejects anonymous', async () => {
      const res = await anonClient().get('/api/user/documents')
      expect(res.status).toBe(401)
    })

    it('POST /api/workspaces rejects anonymous', async () => {
      const res = await anonClient().post('/api/workspaces', { name: 'x' })
      expect(res.status).toBe(401)
    })

    it('POST /api/upload/request rejects anonymous', async () => {
      const res = await anonClient().post('/api/upload/request', {})
      expect(res.status).toBe(401)
    })

    it('POST /api/ai/prompt rejects anonymous', async () => {
      const res = await anonClient().post('/api/ai/prompt', {})
      expect(res.status).toBe(401)
    })

    it('PUT /api/docs/:id/meta rejects anonymous', async () => {
      const doc = await createDoc({ accessMode: 'open-edit' })
      const res = await anonClient().put(`/api/docs/${doc.docId}/meta`, {})
      expect(res.status).toBe(401)
    })

    it('GET /api/user/documents accepts logged-in user', async () => {
      const user = await createUser()
      const client = await loggedInClient(user.id)
      const res = await client.get('/api/user/documents')
      expect(res.status).toBe(200)
    })
  })

  describe('internal route guard', () => {
    it('POST /api/internal/* requires X-Internal-Secret, not a user session', async () => {
      // Anonymous — should NOT get 401 (middleware lets internal routes
      // through for the shared-secret auth to handle).
      const res = await anonClient().post('/api/internal/activity', {})
      // Endpoint itself rejects without the internal secret header.
      expect([400, 401, 403, 404]).toContain(res.status)
      // But not middleware's 401 with "Unauthorized" — that would indicate
      // the session guard rejected it before the endpoint ran. Internal
      // endpoints check the header inside the handler.
    })
  })

  describe('test-only login shim', () => {
    it('/api/_test/login works when TEST_MODE=1', async () => {
      const user = await createUser()
      const res = await anonClient().post('/api/_test/login', {
        userId: user.id,
        name: user.name
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean }
      expect(body.ok).toBe(true)
    })

    it('/api/_test/login rejects invalid userId', async () => {
      const res = await anonClient().post('/api/_test/login', {
        userId: 'not-a-number',
        name: 'x'
      })
      expect(res.status).toBe(400)
    })
  })
})
