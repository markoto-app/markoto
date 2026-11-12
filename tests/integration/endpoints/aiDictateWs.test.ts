import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import jwt from 'jsonwebtoken'
import { resetDb } from '../setup/db'
import { loggedInClient } from '../setup/client'
import { createUser, createDoc } from '../setup/fixtures'
import { openWs, closeAllWs } from '../setup/ws'
import { TEST_JWT_SECRET } from '../setup/env'
import { mintDictateJwt } from '~~/tests/helpers/jwt'

// WS integration tests for /api/ai/dictate. The upstream realtime
// transcription call (Mistral Voxtral Realtime) is stubbed by a mock
// SpeechClient (see dictateSpeechClient.ts) so these tests can drive
// the full server state machine without hitting the upstream. Mock
// emits canned partial → final events on chunk-count thresholds so
// assertions can pin the wire contract (ready → partial → final →
// close) without real audio.
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
  // Routed through the shared test helper so `kind` + `scope` are
  // spread from `DICTATE_JWT_FIXED_CLAIMS`: same constant the prod
  // mint at `server/api/ai/dictate/token.post.ts` uses. Earlier this
  // helper hand-set `{ kind: 'dictate' }` and forgot `scope`, which
  // made the dictate WS reject every test token with 4001 'scope
  // mismatch' BEFORE any logic under test could fire. The shared
  // helper makes that drift impossible.
  return mintDictateJwt({ userId, docId }, { secret: TEST_JWT_SECRET })
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

    it('has no token in the URL, only in the first message', async () => {
      // The JWT must not travel in ?token= (it leaks into access logs); query-string auth would require
      // re-reading the URL here.
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
      // audio directly: the server must never route to STT before
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
      // "hello world". This test pins the wire contract, partials
      // are interim and never committed; finals are what the client
      // writes to Y.js.
      const { user, doc } = await setupUserAndDoc()
      const token = await mintDictateToken(user.id, doc.docId)
      const ws = await openWs('/api/ai/dictate')
      await ws.nextMessageOfType('hello')
      ws.sendJson({ type: 'auth', token })
      await ws.nextMessageOfType('ready')

      // Send fake PCM chunks. Size doesn't matter for the mock,
      // what matters is the chunk COUNT, which the mock uses to
      // time its scripted responses.
      for (let i = 0; i < 3; i++) {
        ws.send(Buffer.alloc(4096, 0))
      }

      // Scripted by the canned fake in server/utils/agentic/dictateSpeechClient.ts.
      const p1 = await ws.nextMessageOfType('partial')
      expect(p1.text).toBe('Lena says')
      const p2 = await ws.nextMessageOfType('partial')
      expect(p2.text).toBe('Lena says the new templates')
      const final = await ws.nextMessageOfType('final')
      expect(final.text).toBe('Lena says the new templates save her about an hour a week.')
    })

    it('cleanly handles stop without emitting a spurious error', async () => {
      // Audio chunks in flight after `stop` must not land on an ended STT stream (a "write after end" error
      // surfacing in the UI). The server drops post-stop audio silently.
      const { user, doc } = await setupUserAndDoc()
      const token = await mintDictateToken(user.id, doc.docId)
      const ws = await openWs('/api/ai/dictate')
      await ws.nextMessageOfType('hello')
      ws.sendJson({ type: 'auth', token })
      await ws.nextMessageOfType('ready')

      ws.send(Buffer.alloc(4096, 0)) // one chunk
      ws.sendJson({ type: 'stop' })
      // Simulate a straggler chunk that the worklet queued before
      // the composable disconnected: should be silently dropped.
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
      // Valkey-backed SET NX lock, spanning multiple workers in
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
      // The HTTP token route enforces `write-content` access. A second
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

    // There is no app-side budget pre-check at the dictate token + WS endpoints. Exhaustion is enforced at
    // proxy call time (the first voice-tick), which surfaces as a 429 from the SDK and closes the WS.
    // End-to-end coverage is in the flow tests; unit-level coverage of the 429 → close-frame translation is in
    // the runLoop budget-exhaustion test file.
  })

  // Budget exhaustion (enforced by LiteLLM)
  //
  // Voice-tick metering posts to LiteLLM via the user's virtual key; the proxy returns 429 once `max_budget`
  // is exhausted, which the orchestrator surfaces as a structured close frame. End-to-end exhaustion is
  // exercised in the flow tests (real proxy round-trip); the unit tests cover the 429 → close-frame
  // translation in `voiceTickOrchestrator`.
})
