import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import { createUser } from '../setup/fixtures'

// POST /api/ai/transcribe — validation surface only. The Mistral
// Voxtral Mini Transcribe call itself isn't exercised here (tests
// use a dummy API key) but every request passes through the full
// validation ladder before reaching the upstream, so 4xx paths are
// fully covered.
//
// Happy-path is covered indirectly: if validation lets a request
// through, the upstream fails with its own error — that branch
// surfaces as a 502 from our endpoint and doesn't need integration
// coverage since it's just upstream error propagation.

// Minimal valid base64-encoded payload — 200 bytes of zeroes, well above
// the 100-byte minimum. The MIME type is checked against an allowlist
// upstream; the contents themselves never need to decode to anything
// legitimate for validation to succeed.
const MIN_VALID_AUDIO_B64 = Buffer.alloc(200, 0).toString('base64')
const VALID_MIME = 'audio/webm;codecs=opus'

describe('POST /api/ai/transcribe', () => {
  beforeEach(async () => {
    await resetDb()
  })

  describe('auth', () => {
    it('returns 401 when not logged in', async () => {
      const res = await anonClient().post('/api/ai/transcribe', {
        audio: MIN_VALID_AUDIO_B64,
        mimeType: VALID_MIME
      })
      expect(res.status).toBe(401)
    })
  })

  describe('validation', () => {
    it('returns 400 with no mimeType', async () => {
      const user = await createUser()
      const client = await loggedInClient(user.id)
      const res = await client.post('/api/ai/transcribe', {
        audio: MIN_VALID_AUDIO_B64
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { message?: string }
      expect(body.message).toMatch(/mimeType/i)
    })

    it('returns 400 with an unsupported mimeType', async () => {
      const user = await createUser()
      const client = await loggedInClient(user.id)
      const res = await client.post('/api/ai/transcribe', {
        audio: MIN_VALID_AUDIO_B64,
        mimeType: 'application/octet-stream'
      })
      expect(res.status).toBe(400)
    })

    it('accepts transcription-compatible MIME types', async () => {
      // Each of these must pass OUR validation ladder. The test env
      // uses a dummy API key so the upstream call itself fails with
      // a 502 from our endpoint — that's fine; the assertion here
      // only distinguishes "our mimeType gate rejected this" (bad)
      // from "the transcription upstream rejected this" (fine, upstream).
      const user = await createUser()
      const client = await loggedInClient(user.id)
      const cases = [
        'audio/webm',
        'audio/webm;codecs=opus',
        'audio/ogg',
        'audio/ogg;codecs=opus',
        'audio/wav'
      ]
      for (const mimeType of cases) {
        const res = await client.post('/api/ai/transcribe', {
          audio: MIN_VALID_AUDIO_B64,
          mimeType
        })
        if (res.status === 400) {
          const body = await res.json() as { message?: string }
          expect(body.message ?? '', `${mimeType} must not be rejected at our mimeType gate`).not.toMatch(/mimeType/i)
        }
      }
    })

    it('rejects MP4 / AAC (Safari MediaRecorder default)', async () => {
      // Voxtral Mini Transcribe doesn't accept MP4 containers (and
      // pre-Phase-5 the legacy Cloud STT path didn't either; the
      // even-earlier Gemini-era path DID accept them, hence the
      // explicit reject here). The server must now return 400 so
      // the client gets a clean error — the upstream would otherwise
      // return a confusing 400.
      const user = await createUser()
      const client = await loggedInClient(user.id)
      for (const mimeType of ['audio/mp4', 'audio/mpeg', 'audio/mp3']) {
        const res = await client.post('/api/ai/transcribe', {
          audio: MIN_VALID_AUDIO_B64,
          mimeType
        })
        expect(res.status).toBe(400)
      }
    })

    it('returns 400 with no audio payload', async () => {
      const user = await createUser()
      const client = await loggedInClient(user.id)
      const res = await client.post('/api/ai/transcribe', {
        mimeType: VALID_MIME
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { message?: string }
      expect(body.message).toMatch(/audio/i)
    })

    it('returns 400 with audio too short', async () => {
      const user = await createUser()
      const client = await loggedInClient(user.id)
      // 50 bytes — well under the 100-byte minimum.
      const shortAudio = Buffer.alloc(50, 0).toString('base64')
      const res = await client.post('/api/ai/transcribe', {
        audio: shortAudio,
        mimeType: VALID_MIME
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { message?: string }
      expect(body.message).toMatch(/short/i)
    })

    it('returns 413 with audio over the size limit', async () => {
      const user = await createUser()
      const client = await loggedInClient(user.id)
      // 6 MiB — over the 5 MiB cap. Base64 inflates by ~33%, so the
      // wire payload is ~8 MiB, but the server validates against the
      // decoded size.
      const bigAudio = Buffer.alloc(6 * 1024 * 1024, 0).toString('base64')
      const res = await client.post('/api/ai/transcribe', {
        audio: bigAudio,
        mimeType: VALID_MIME
      })
      expect(res.status).toBe(413)
    })

    it('accepts requests with a languageCode field', async () => {
      // Guard against a regression that starts 400ing valid payloads
      // when the client ships a UI locale. Per-locale mapping
      // (`de` → `de-DE` etc.) is covered by the unit test for
      // `normalizeLanguageCode`; this test only verifies the field is
      // forwarded past our own validation ladder. The dummy upstream
      // key surfaces as a 502 which is fine — we're asserting what
      // it's NOT (a 400 from our gate).
      const user = await createUser()
      const client = await loggedInClient(user.id)
      for (const languageCode of ['de', 'de-DE', 'fr-FR', 'en', undefined]) {
        const res = await client.post('/api/ai/transcribe', {
          audio: MIN_VALID_AUDIO_B64,
          mimeType: VALID_MIME,
          languageCode
        })
        // Asserting NOT-400 — the test is about the validation gate,
        // not the upstream transcribe-service result (502 from a dummy
        // key is fine; what's wrong is a 400 from our own gate).
        expect(res.status, `languageCode=${languageCode} unexpectedly 400'd`).not.toBe(400)
      }
    })
  })

  // ─── Budget exhaustion ────────────────────────────────────────────────
  //
  // Phase 6: budget enforcement moved to LiteLLM virtual keys. The proxy
  // surfaces 429 with a budget-exceeded body when a key's spend exceeds
  // its `max_budget`; the app translates that to its standard error
  // shape. We can no longer simulate exhaustion via DB seeding because
  // there is no app-side counter — exhaustion only manifests through a
  // real LiteLLM round-trip. That is exercised end-to-end in the flow
  // tests; HTTP-level coverage of the 429-translation path lives in the
  // unit tests for `isBudgetExceededError` + the agentic loop's catch
  // block.

  // ─── Rate limiting (anti-abuse, 60/hour/user) ─────────────────────────

  describe('rate limit (60 requests/hour/user)', () => {
    it('does not fire for a single legitimate request', async () => {
      // Sanity: the per-user 60/hour rate limit shouldn't even
      // approach with one request. Ensure no 429 contamination from
      // earlier tests by using a fresh user.
      const u = await createUser()
      const client = await loggedInClient(u.id)
      const res = await client.post('/api/ai/transcribe', {
        audio: MIN_VALID_AUDIO_B64,
        mimeType: VALID_MIME
      })
      expect(res.status).not.toBe(429)
    })
  })
})
