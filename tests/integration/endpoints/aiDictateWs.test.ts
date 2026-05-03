import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import jwt from 'jsonwebtoken'
import { resetDb } from '../setup/db'
import { loggedInClient } from '../setup/client'
import { createUser, createDoc } from '../setup/fixtures'
import { openWs, closeAllWs } from '../setup/ws'
import { TEST_JWT_SECRET } from '../setup/env'

// WS integration tests for /api/ai/dictate. The Cloud STT call is
// stubbed by a mock SpeechClient (see dictateSpeechClient.ts) so
// these tests can drive the full server state machine without
// hitting Google. Mock emits canned partial → final events on
// chunk-count thresholds so assertions can pin the wire contract
// (ready → partial → final → close) without real audio.
//
// Covered:
//   1. happy-path handshake (hello → auth → ready)
//   2. 401 on bad / missing token
//   3. 4000 on pre-auth binary
//   4. 4000 on auth timeout
//   5. 4001 on concurrent-session lock (second session rejected)
//   6. partial + final message flow from mock SpeechClient
//   7. graceful stop path (no "write after end" error)

async function mintDictateToken(userId: number, docId: string): Promise<string> {
  // Match the prod mint shape exactly (server/api/ai/dictate/token.post.ts).
  // Both `kind` and `scope` are required: the server's auth path checks
  // `payload.kind === 'dictate'` AND `payload.scope === 'dictate'`. The
  // `scope` claim is defense-in-depth — it lets the Hocuspocus auth path
  // reject any token carrying a non-empty `scope` (so a leaked dictate
  // token can't be replayed against the WS sync server). Earlier this
  // helper omitted `scope`, which made the dictate WS reject every test
  // token with 4001 'scope mismatch' BEFORE any of the actual logic
  // under test (budget checks, session locks) could fire.
  return jwt.sign(
    { userId, docId, kind: 'dictate', scope: 'dictate' },
    TEST_JWT_SECRET,
    { expiresIn: '60s' }
  )
}

async function setupUserAndDoc() {
  const user = await createUser()
  const doc = await createDoc({ ownerId: user.id, accessMode: 'private' })
  return { user, doc }
}

describe('WS /api/ai/dictate', () => {
  beforeEach(async () => {
    await resetDb()
  })

  afterEach(() => {
    closeAllWs()
  })

  describe('handshake', () => {
    it('opens, says hello, accepts valid auth, becomes ready', async () => {
      const { user, doc } = await setupUserAndDoc()
      const token = await mintDictateToken(user.id, doc.docId)
      const ws = await openWs('/api/ai/dictate')

      const hello = await ws.nextMessageOfType('hello')
      expect(hello).toEqual({ type: 'hello' })

      ws.sendJson({ type: 'auth', token, languageCode: 'en' })
      const ready = await ws.nextMessageOfType('ready')
      expect(ready).toEqual({ type: 'ready' })
    })

    it('has no token in the URL — only in the first message', async () => {
      // Guards the audit fix: the JWT used to live in ?token= which
      // leaked into access logs. A regression that re-introduces
      // query-string auth would require re-reading the URL here.
      const ws = await openWs('/api/ai/dictate')
      expect(ws.raw.url).not.toMatch(/token=/)
      ws.close()
    })

    it('closes on missing token with 4001', async () => {
      const ws = await openWs('/api/ai/dictate')
      await ws.nextMessageOfType('hello')
      ws.sendJson({ type: 'auth' }) // no token
      const err = await ws.nextMessageOfType('error')
      expect(err.message).toMatch(/missing token/i)
      const close = await ws.closed()
      expect(close.code).toBe(4001)
    })

    it('closes on invalid token with 4001', async () => {
      const ws = await openWs('/api/ai/dictate')
      await ws.nextMessageOfType('hello')
      ws.sendJson({ type: 'auth', token: 'nonsense' })
      const err = await ws.nextMessageOfType('error')
      expect(err.message).toMatch(/invalid|expired/i)
      const close = await ws.closed()
      expect(close.code).toBe(4001)
    })

    it('closes on expired token with 4001', async () => {
      const { user, doc } = await setupUserAndDoc()
      // Backdated so it's already expired.
      const expired = jwt.sign(
        { userId: user.id, docId: doc.docId, kind: 'dictate' },
        TEST_JWT_SECRET,
        { expiresIn: '-1s' }
      )
      const ws = await openWs('/api/ai/dictate')
      await ws.nextMessageOfType('hello')
      ws.sendJson({ type: 'auth', token: expired })
      const err = await ws.nextMessageOfType('error')
      expect(err.message).toMatch(/invalid|expired/i)
      const close = await ws.closed()
      expect(close.code).toBe(4001)
    })

    it('rejects malformed token payload (kind mismatch) with 4001', async () => {
      // A Hocuspocus-scoped JWT must NOT double as a dictation one.
      // This test pins that kind-field gate against a future rotation
      // where the two secrets accidentally align.
      const hocusToken = jwt.sign(
        { userId: 1, docId: 'd', kind: 'hocuspocus' },
        TEST_JWT_SECRET,
        { expiresIn: '60s' }
      )
      const ws = await openWs('/api/ai/dictate')
      await ws.nextMessageOfType('hello')
      ws.sendJson({ type: 'auth', token: hocusToken })
      const err = await ws.nextMessageOfType('error')
      expect(err.message).toMatch(/malformed/i)
      const close = await ws.closed()
      expect(close.code).toBe(4001)
    })
  })

  describe('pre-auth protection', () => {
    it('closes with 4000 when the first frame is binary', async () => {
      // Guards against a malicious client that skips auth and ships
      // audio directly — the server must never route to STT before
      // verifying the JWT.
      const ws = await openWs('/api/ai/dictate')
      await ws.nextMessageOfType('hello')
      ws.send(Buffer.from([0, 0, 0, 0]))
      const err = await ws.nextMessageOfType('error')
      expect(err.message).toMatch(/auth/i)
      const close = await ws.closed()
      expect(close.code).toBe(4000)
    })

    it('closes with 4000 when the first frame has the wrong type', async () => {
      const ws = await openWs('/api/ai/dictate')
      await ws.nextMessageOfType('hello')
      ws.sendJson({ type: 'stop' }) // stop before auth
      const err = await ws.nextMessageOfType('error')
      const close = await ws.closed()
      expect(close.code).toBe(4000)
      expect(err.message).toMatch(/auth|first/i)
    })
  })

  describe('transcription flow', () => {
    it('emits partial → final messages as the mock stream responds', async () => {
      // The MOCK SpeechClient (dictateSpeechClient.ts) emits a canned
      // sequence keyed to chunk-count: chunk 1 → partial "hello",
      // chunk 2 → partial "hello world", chunk 3 → final
      // "hello world". This test pins the wire contract — partials
      // are interim and never committed; finals are what the client
      // writes to Y.js.
      const { user, doc } = await setupUserAndDoc()
      const token = await mintDictateToken(user.id, doc.docId)
      const ws = await openWs('/api/ai/dictate')
      await ws.nextMessageOfType('hello')
      ws.sendJson({ type: 'auth', token })
      await ws.nextMessageOfType('ready')

      // Send fake PCM chunks. Size doesn't matter for the mock —
      // what matters is the chunk COUNT, which the mock uses to
      // time its scripted responses.
      for (let i = 0; i < 3; i++) {
        ws.send(Buffer.alloc(4096, 0))
      }

      const p1 = await ws.nextMessageOfType('partial')
      expect(p1.text).toBe('hello')
      const p2 = await ws.nextMessageOfType('partial')
      expect(p2.text).toBe('hello world')
      const final = await ws.nextMessageOfType('final')
      expect(final.text).toBe('hello world')
    })

    it('cleanly handles stop without emitting a spurious error', async () => {
      // The "write after end" race was a real bug: audio chunks in
      // flight after `stop` landed on an ended STT stream and
      // surfaced as UI errors. The server now drops post-stop audio
      // silently. This test guards that behavior.
      const { user, doc } = await setupUserAndDoc()
      const token = await mintDictateToken(user.id, doc.docId)
      const ws = await openWs('/api/ai/dictate')
      await ws.nextMessageOfType('hello')
      ws.sendJson({ type: 'auth', token })
      await ws.nextMessageOfType('ready')

      ws.send(Buffer.alloc(4096, 0)) // one chunk
      ws.sendJson({ type: 'stop' })
      // Simulate a straggler chunk that the worklet queued before
      // the composable disconnected — should be silently dropped.
      ws.send(Buffer.alloc(4096, 0))

      // Close arrives naturally from the STT `end` event.
      const close = await ws.closed()
      // 1000 = normal; anything else (1011 = stt error) would
      // signal the write-after-end race slipped the guard.
      expect(close.code).toBe(1000)
    })
  })

  describe('concurrent session cap', () => {
    it('rejects a second session for the same user with 4001', async () => {
      // Valkey-backed SET NX lock — spanning multiple workers in
      // prod. In-memory would silently fail across workers but
      // pass this single-process test, so this test also exercises
      // that the lock key format (lock:ai-dictate-active:{uid})
      // stays stable.
      const { user, doc } = await setupUserAndDoc()
      const tokenA = await mintDictateToken(user.id, doc.docId)
      const tokenB = await mintDictateToken(user.id, doc.docId)

      const wsA = await openWs('/api/ai/dictate')
      await wsA.nextMessageOfType('hello')
      wsA.sendJson({ type: 'auth', token: tokenA })
      await wsA.nextMessageOfType('ready')

      const wsB = await openWs('/api/ai/dictate')
      await wsB.nextMessageOfType('hello')
      wsB.sendJson({ type: 'auth', token: tokenB })
      const err = await wsB.nextMessageOfType('error')
      expect(err.message).toMatch(/already active/i)
      const close = await wsB.closed()
      expect(close.code).toBe(4001)
    })

    it('allows a second session for the SAME user AFTER the first closes', async () => {
      // Releasing the lock on close must actually fire. A regression
      // that skipped the `releaseSessionLock` call would appear as:
      // user closes their session, opens a fresh tab, gets "Another
      // dictation session is already active" until the TTL expires
      // ~10 min later. Extremely annoying UX; worth a dedicated test.
      const { user, doc } = await setupUserAndDoc()

      const wsA = await openWs('/api/ai/dictate')
      await wsA.nextMessageOfType('hello')
      wsA.sendJson({ type: 'auth', token: await mintDictateToken(user.id, doc.docId) })
      await wsA.nextMessageOfType('ready')
      wsA.close()
      await wsA.closed()

      // Give Valkey a moment to process the DEL. The `close` hook
      // fires `releaseSessionLock` without awaiting (best-effort),
      // so a tiny delay is more reliable than racing it.
      await new Promise(r => setTimeout(r, 100))

      const wsB = await openWs('/api/ai/dictate')
      await wsB.nextMessageOfType('hello')
      wsB.sendJson({ type: 'auth', token: await mintDictateToken(user.id, doc.docId) })
      const ready = await wsB.nextMessageOfType('ready')
      expect(ready.type).toBe('ready')
    })

    it('allows concurrent sessions for DIFFERENT users', async () => {
      // Lock is keyed per-user; two different users dictating
      // simultaneously is the expected shape.
      const { user: userA, doc: docA } = await setupUserAndDoc()
      const { user: userB, doc: docB } = await setupUserAndDoc()

      const wsA = await openWs('/api/ai/dictate')
      await wsA.nextMessageOfType('hello')
      wsA.sendJson({ type: 'auth', token: await mintDictateToken(userA.id, docA.docId) })
      await wsA.nextMessageOfType('ready')

      const wsB = await openWs('/api/ai/dictate')
      await wsB.nextMessageOfType('hello')
      wsB.sendJson({ type: 'auth', token: await mintDictateToken(userB.id, docB.docId) })
      const ready = await wsB.nextMessageOfType('ready')
      expect(ready.type).toBe('ready')
    })
  })

  describe('doc access gating', () => {
    it('returns 403 at the token endpoint if the user cannot edit the doc', async () => {
      // The HTTP token route enforces requireDocEditAccess. A second
      // user trying to mint a dictation token for someone else's
      // private doc must be blocked BEFORE they can even open the
      // WS. This test pins the HTTP gate; the WS itself only sees
      // the kind-validated JWT.
      const owner = await createUser()
      const intruder = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })

      const client = await loggedInClient(intruder.id)
      const res = await client.post('/api/ai/dictate/token', { docId: doc.docId })
      expect(res.status).toBe(403)
    })

    it('returns 400 if docId is missing from the token request', async () => {
      const user = await createUser()
      const client = await loggedInClient(user.id)
      const res = await client.post('/api/ai/dictate/token', {})
      expect(res.status).toBe(400)
    })

    it('returns 401 if the token endpoint is called unauthenticated', async () => {
      const { anonClient } = await import('../setup/client')
      const res = await anonClient().post('/api/ai/dictate/token', { docId: 'x' })
      expect(res.status).toBe(401)
    })

    // ─── Token-mint budget pre-check (UX-saving early reject) ───────────
    //
    // The WS-level interaction gate (covered below) is the safety net.
    // The token endpoint runs the SAME check first so an exhausted user
    // sees a 402 the instant they click the mic button — instead of:
    //   click mic → token (200) → WS opens → browser asks for mic →
    //   user clicks Allow → audio worklet spins up → WS closes with
    //   budget-exhausted. (That whole sequence flashed the recording
    //   indicator + asked for mic permission for nothing.)
    //
    // The WS-level gate stays in place because the 60s token TTL leaves
    // a window for state to change before the WS actually opens.

    it('returns 402 with the upgrade-CTA contract when interactions are exhausted', async () => {
      const { TIERS } = await import('../../../shared/config/tiers')
      const { testDb } = await import('../setup/db')
      const { currentPeriodStart } = await import('../../../server/utils/billing')
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id })
      await testDb().query(
        `INSERT INTO ai_usage_period (attributed_to, period_start, interactions_used) VALUES ($1, $2, $3)`,
        [`user:${owner.id}`, currentPeriodStart(), TIERS.free.interactionsPerMonth]
      )

      const client = await loggedInClient(owner.id)
      const res = await client.post('/api/ai/dictate/token', { docId: doc.docId })

      expect(res.status).toBe(402)
      const body = await res.json() as {
        data?: {
          code?: string
          messageKey?: string
          recovery?: { kind?: string, href?: string, labelKey?: string }
          plan?: string
          remaining?: number
        }
      }
      // Same contract shape useErrorHandler reads for the upgrade toast.
      expect(body.data?.code).toBe('ai/budget-exhausted')
      expect(body.data?.messageKey).toBe('ai.budgetExhaustedDescription')
      expect(body.data?.recovery).toEqual({
        kind: 'link', href: '/pricing', labelKey: 'ai.upgradeCta'
      })
      expect(body.data?.plan).toBe('free')
      expect(body.data?.remaining).toBe(0)
    })

    it('exhausted user does NOT receive a token (regression guard for the early-reject)', async () => {
      // If the budget check ever moves below the token mint, this
      // test breaks: the response would carry a `token` field. The
      // existing "exhausted close at WS open" test (further down)
      // continues to cover the safety-net path.
      const { TIERS } = await import('../../../shared/config/tiers')
      const { testDb } = await import('../setup/db')
      const { currentPeriodStart } = await import('../../../server/utils/billing')
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id })
      await testDb().query(
        `INSERT INTO ai_usage_period (attributed_to, period_start, interactions_used) VALUES ($1, $2, $3)`,
        [`user:${owner.id}`, currentPeriodStart(), TIERS.free.interactionsPerMonth]
      )

      const client = await loggedInClient(owner.id)
      const res = await client.post('/api/ai/dictate/token', { docId: doc.docId })
      const body = await res.json() as { token?: string }
      expect(body.token).toBeUndefined()
    })

    it('a Max user with the same usage count gets a token (plan-aware gate)', async () => {
      // Sanity: gate uses ACTUAL plan, not a default-to-free
      // assumption. A Max user past Free's cap is still well below
      // their own cap and should pass.
      const { testDb } = await import('../setup/db')
      const { currentPeriodStart } = await import('../../../server/utils/billing')
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id })
      const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
      await testDb().query(
        `UPDATE users SET plan='max', plan_valid_until=$1, stripe_current_period_start=$2 WHERE id=$3`,
        [future, past, owner.id]
      )
      // Way past Free's cap (100), nowhere near Max's (8000).
      await testDb().query(
        `INSERT INTO ai_usage_period (attributed_to, period_start, interactions_used) VALUES ($1, $2, $3)`,
        [`user:${owner.id}`, currentPeriodStart(), 500]
      )

      const client = await loggedInClient(owner.id)
      const res = await client.post('/api/ai/dictate/token', { docId: doc.docId })
      expect(res.status).toBe(200)
      const body = await res.json() as { token?: string }
      expect(typeof body.token).toBe('string')
    })
  })

  // ─── Budget exhaustion at WS open ──────────────────────────────────────
  //
  // The user's stated concern: "users running into limits while they work,
  // especially while voice recording". The dictate handler does TWO budget
  // checks at open:
  //   (1) Daily audio-ms budget (Valkey) — has TEST_MODE bypass, can't
  //       trigger from integration without disabling the bypass.
  //   (2) Monthly interaction budget (Postgres) — read via
  //       resolveBillingContext, NO bypass on the read path. We can seed
  //       ai_usage_period to drive this case.
  //
  // (1) is covered by unit tests of the helpers; (2) is covered here.
  // The contract: the user sees a structured close frame BEFORE STT spin-
  // up so the client UI can render "you're out of AI actions, upgrade".

  describe('budget exhaustion at WS open', () => {
    async function seedUsage(attributedTo: string, used: number) {
      const { testDb } = await import('../setup/db')
      const { currentPeriodStart } = await import('../../../server/utils/billing')
      await testDb().query(
        `INSERT INTO ai_usage_period (attributed_to, period_start, interactions_used) VALUES ($1, $2, $3)`,
        [attributedTo, currentPeriodStart(), used]
      )
    }

    it('exhausted MONTHLY interactions → close 4002 with "interactions" reason BEFORE STT', async () => {
      // Defense-in-depth scenario: the user obtained a dictate token
      // (e.g. minted before they hit their cap, or a token-mint race),
      // but is now exhausted by the time the WS opens. The WS-level
      // gate is the safety net — the token endpoint normally pre-checks
      // budget and returns 402 directly (covered above), but the 60s
      // token TTL leaves a window where state can drift.
      //
      // Critical: the frame includes `reason: 'interactions'` so the
      // client UI can distinguish "monthly cap" from "daily audio cap"
      // and show the right upgrade copy.
      const { TIERS } = await import('../../../shared/config/tiers')
      const { user, doc } = await setupUserAndDoc()
      // Push past the Free monthly cap.
      await seedUsage(`user:${user.id}`, TIERS.free.interactionsPerMonth)

      const ws = await openWs('/api/ai/dictate')
      await ws.nextMessageOfType('hello')
      ws.sendJson({ type: 'auth', token: await mintDictateToken(user.id, doc.docId) })

      const exhausted = await ws.nextMessageOfType('budget-exhausted')
      expect(exhausted).toMatchObject({
        type: 'budget-exhausted',
        remaining: 0,
        reason: 'interactions'
      })
      const close = await ws.closed()
      expect(close.code).toBe(4002)
      expect(close.reason).toMatch(/interactions exhausted/)
    })

    it('exhausted user gets the close BEFORE the "ready" frame (no audio-worklet spinup)', async () => {
      // The whole point of the open-time gate is that the client
      // shouldn't wire up its mic + worklet just to immediately tear
      // it down. Pin: NO `ready` message ever arrives for an
      // exhausted user. (If a refactor moved the budget check after
      // the ready emit, real users would briefly see the recording
      // indicator + then get an error — annoying, frustrating.)
      const { TIERS } = await import('../../../shared/config/tiers')
      const { user, doc } = await setupUserAndDoc()
      await seedUsage(`user:${user.id}`, TIERS.free.interactionsPerMonth)

      const ws = await openWs('/api/ai/dictate')
      await ws.nextMessageOfType('hello')
      ws.sendJson({ type: 'auth', token: await mintDictateToken(user.id, doc.docId) })

      // Race: collect every message until close. Assert no 'ready'.
      const seen: string[] = []
      const close = await new Promise<{ code: number, reason: string }>((resolve) => {
        ws.raw.on('message', (data: Buffer) => {
          try {
            const m = JSON.parse(data.toString()) as { type?: string }
            if (m.type) seen.push(m.type)
          } catch { /* binary */ }
        })
        ws.raw.on('close', (code: number, reason: Buffer) => {
          resolve({ code, reason: reason.toString() })
        })
      })

      expect(close.code).toBe(4002)
      expect(seen).toContain('budget-exhausted')
      expect(seen).not.toContain('ready')
    })

    it('a paid (Max) user with the same SAME usage count is NOT exhausted (cap is much higher)', async () => {
      // Sanity: confirm the gate is plan-aware. A Max user with 100
      // interactions used is still nowhere near their cap; should
      // proceed to ready. If this test ever breaks because of a
      // plan-resolution regression, exhausted-Free user behavior
      // gets misapplied to paying customers — much worse than the
      // inverse.
      const { user, doc } = await setupUserAndDoc()
      // Promote user to Max with valid stripe anchor.
      const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
      const { testDb } = await import('../setup/db')
      await testDb().query(
        `UPDATE users SET plan = 'max', plan_valid_until = $1, stripe_current_period_start = $2 WHERE id = $3`,
        [future, past, user.id]
      )
      // Seed only 100 used — far below Max's monthly cap.
      await testDb().query(
        `INSERT INTO ai_usage_period (attributed_to, period_start, interactions_used) VALUES ($1, $2, $3)`,
        [`user:${user.id}`, past, 100]
      )

      const ws = await openWs('/api/ai/dictate')
      await ws.nextMessageOfType('hello')
      ws.sendJson({ type: 'auth', token: await mintDictateToken(user.id, doc.docId) })

      // Should reach ready, not budget-exhausted.
      const ready = await ws.nextMessageOfType('ready')
      expect(ready.type).toBe('ready')
    })
  })
})
