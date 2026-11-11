import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import { createDoc, createUser } from '../setup/fixtures'
import { createAnonDoc } from '../setup/anonGate'
import { TEST_INTERNAL_SECRET } from '../setup/env'

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

    it('GET /api/status is public and returns a per-component board', async () => {
      const res = await anonClient().get('/api/status')
      // Status is a REPORT, not a gate — always 200 so a status-page
      // poller's fetch succeeds even when a component is down.
      expect(res.status).toBe(200)
      const body = await res.json() as {
        status: string
        checks: Record<string, { status: string, latencyMs: number }>
      }
      expect(['ok', 'degraded']).toContain(body.status)
      // Core components are reported (postgres + valkey are live in the
      // test stack, so they should probe 'ok'); the board carries the
      // full component set a status page renders.
      expect(body.checks.postgres.status).toBe('ok')
      expect(body.checks.valkey.status).toBe('ok')
      for (const key of ['postgres', 'valkey', 'sync', 's3', 'renderer', 'markitdown', 'litellm']) {
        expect(body.checks[key]).toBeDefined()
        expect(['ok', 'down', 'skipped']).toContain(body.checks[key]!.status)
      }
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
      // Anonymous doc created by this (cookie-holding) anonymous browser —
      // only the creating browser may delete it.
      const creator = anonClient()
      const created = await createAnonDoc(creator)
      const { docId } = await created.json() as { docId: string }
      const res = await creator.delete(`/api/docs/${docId}`)
      expect(res.status).toBe(200)
    })

    it('POST /api/docs (doc creation) is public', async () => {
      const res = await createAnonDoc(anonClient())
      // Creation returns 200 with a new docId (through the anonymous gate).
      expect(res.status).toBe(200)
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

    it('GET /api/billing/tiers is public and returns every plan', async () => {
      const res = await anonClient().get('/api/billing/tiers')
      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, { litellmBudgetUsd: number }>
      for (const plan of ['free', 'pro', 'team', 'business']) {
        expect(body[plan]?.litellmBudgetUsd, `${plan} missing`).toBeGreaterThan(0)
      }
    })

    it('GET /api/billing/prices is public and returns EUR + CHF prices for every paid plan', async () => {
      const res = await anonClient().get('/api/billing/prices')
      expect(res.status).toBe(200)
      const body = await res.json() as { currencies?: string[], prices?: Record<string, Record<string, { month: number, year: number }>>, source?: string }
      expect(body.currencies).toEqual(['eur', 'chf'])
      // Billing on: Stripe (id overrides carry no amount → planned fallback).
      expect(body.source).toBe('stripe')
      for (const currency of ['eur', 'chf']) {
        for (const plan of ['pro', 'team', 'business']) {
          expect(body.prices?.[currency]?.[plan]?.month, `${currency} ${plan}`).toBeGreaterThan(0)
          expect(body.prices?.[currency]?.[plan]?.year, `${currency} ${plan}`).toBeGreaterThan(0)
        }
      }
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

  describe('default-deny backstop', () => {
    // The middleware is DEFAULT-DENY: any /api route not in the explicit
    // public whitelist requires a valid session — there is no
    // fall-through-open branch. These tests pin the model itself, not
    // individual endpoints: a regression back to prefix-matching would
    // flip the unknown-route case below from 401 to 404.

    it('GET /api/admin/abuse-reports rejects anonymous at the middleware', async () => {
      const res = await anonClient().get('/api/admin/abuse-reports')
      expect(res.status).toBe(401)
    })

    it('GET /api/admin/ai-spend rejects anonymous', async () => {
      const res = await anonClient().get('/api/admin/ai-spend')
      expect(res.status).toBe(401)
    })

    it('POST /api/abuse-reports is public (DSA Art.16: anyone may notify; the handler validates + bot-checks)', async () => {
      const res = await anonClient().post('/api/abuse-reports', {})
      expect(res.status).toBe(400)
    })

    it('GET /api/anon-gate/challenge is public', async () => {
      const res = await anonClient().get('/api/anon-gate/challenge')
      expect(res.status).toBe(200)
    })

    it('GET /api/health/deep rejects anonymous', async () => {
      const res = await anonClient().get('/api/health/deep')
      expect(res.status).toBe(401)
    })

    it('an UNKNOWN /api route rejects anonymous instead of falling through', async () => {
      // This is the load-bearing default-deny pin: the middleware refuses before routing (a prefix-list model
      // would fall through and 404). It also removes anonymous route enumeration.
      const res = await anonClient().get('/api/route-that-does-not-exist')
      expect(res.status).toBe(401)
    })

    it('an unknown /api route 404s (not 401) for a logged-in user', async () => {
      const user = await createUser()
      const client = await loggedInClient(user.id)
      const res = await client.get('/api/route-that-does-not-exist')
      expect(res.status).toBe(404)
    })

    // Whitelist survivors: routes that are explicitly public (they once relied on the implicit fall-through).
    // A missed entry here breaks an anonymous product surface.

    it('GET /api/version stays public', async () => {
      const res = await anonClient().get('/api/version')
      expect(res.status).toBe(200)
    })

    it('GET /api/_auth/session stays public (pre-login session probe)', async () => {
      const res = await anonClient().get('/api/_auth/session')
      expect(res.status).toBe(200)
    })

    it('GET /api/files/:docId/:fileId stays public (endpoint-gated)', async () => {
      const doc = await createDoc({ accessMode: 'open-edit' })
      const res = await anonClient().get(`/api/files/${doc.docId}/nonexistent-file`)
      // The file doesn't exist so the endpoint 404s — the point is the
      // middleware didn't 401 an anonymous image read on an open doc.
      expect(res.status).not.toBe(401)
    })

    it('HEAD /api/health is treated as GET (external monitors probe with HEAD)', async () => {
      const res = await anonClient().request('/api/health', { method: 'HEAD' })
      expect(res.status).not.toBe(401)
    })
  })

  describe('internal route guard', () => {
    it('POST /api/internal/* requires X-Internal-Secret, not a user session', async () => {
      const res = await anonClient().post('/api/internal/activity', {})
      expect(res.status).toBe(401)
    })

    it('a route under /api/internal/ with no handler is still secret-gated', async () => {
      const res = await anonClient().post('/api/internal/does-not-exist', {})
      expect(res.status).toBe(401)
    })

    it('a valid secret passes the middleware (the handler validates the body)', async () => {
      const res = await anonClient().post('/api/internal/activity', {}, { headers: { 'X-Internal-Secret': TEST_INTERNAL_SECRET } })
      expect(res.status).toBe(400)
    })

    it('internal routes are 404 when the request came through the edge proxy, even with the secret', async () => {
      const edge = { 'X-Forwarded-Host': 'markoto.example', 'X-Real-Ip': '203.0.113.7' }
      const internal = await anonClient().post('/api/internal/activity', {}, { headers: { ...edge, 'X-Internal-Secret': TEST_INTERNAL_SECRET } })
      expect(internal.status).toBe(404)
      const render = await anonClient().get('/_internal/render/some-doc-id', { headers: edge })
      expect(render.status).toBe(404)
      const bootstrap = await anonClient().get('/api/_internal/render-bootstrap?docId=x&t=y', { headers: edge })
      expect(bootstrap.status).toBe(404)
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
