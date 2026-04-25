import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import { createUser } from '../setup/fixtures'

// POST /api/ai/transcribe — validation surface only. The Cloud STT
// call itself isn't exercised here (tests use a dummy API key) but
// every request passes through the full validation ladder before
// reaching Google, so 4xx paths are fully covered.
//
// Happy-path is covered indirectly: if validation lets a request
// through, Cloud STT fails with its own upstream error — that branch
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

    it('accepts Cloud STT-compatible MIME types', async () => {
      // Each of these must pass OUR validation ladder. The test env
      // uses a dummy API key so the Cloud STT call itself fails with
      // a 502 from our endpoint — that's fine; the assertion here
      // only distinguishes "our mimeType gate rejected this" (bad)
      // from "Cloud STT rejected this" (fine, upstream).
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
          if (body.message && /mimeType/i.test(body.message)) {
            throw new Error(`${mimeType} rejected at our gate: ${body.message}`)
          }
        }
      }
    })

    it('rejects MP4 / AAC (Safari MediaRecorder default)', async () => {
      // Cloud STT sync recognize doesn't accept MP4 containers.
      // Pre-migration we passed these through to Gemini which did
      // accept them. The server must now return 400 so the client
      // gets a clean error — Cloud STT would otherwise return a
      // confusing upstream 400.
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
      // forwarded past our own validation ladder. The dummy Cloud
      // STT key surfaces as a 502 which is fine — we're asserting
      // what it's NOT (a 400 from our gate).
      const user = await createUser()
      const client = await loggedInClient(user.id)
      for (const languageCode of ['de', 'de-DE', 'fr-FR', 'en', undefined]) {
        const res = await client.post('/api/ai/transcribe', {
          audio: MIN_VALID_AUDIO_B64,
          mimeType: VALID_MIME,
          languageCode
        })
        if (res.status === 400) {
          const body = await res.json() as { message?: string }
          throw new Error(`languageCode=${languageCode} rejected: ${body.message}`)
        }
      }
    })
  })

  // ─── Budget exhaustion (mid-work scenario) ─────────────────────────────
  //
  // Voice-input is a "tap mic, talk, get text" flow. The budget pre-check
  // is the user's last opportunity to learn they're out of AI actions
  // BEFORE Cloud STT runs (and we incur cost). The error contract must
  // carry enough info for the AIPromptBar to render the upgrade-CTA toast.
  //
  // Pre-check threshold: requires interactionsRemaining >= 5 (a 60s clip
  // costs 5). A user near their cap may see this fire even on a short
  // clip — the alternative is "let them spend their last 4 interactions
  // on a 1s clip", which is fine UX but more complex to implement.

  describe('interaction budget pre-check', () => {
    async function seedUsage(attributedTo: string, used: number) {
      const { testDb } = await import('../setup/db')
      const { currentPeriodStart } = await import('../../../server/utils/billing')
      await testDb().query(
        `INSERT INTO ai_usage_period (attributed_to, period_start, interactions_used) VALUES ($1, $2, $3)`,
        [attributedTo, currentPeriodStart(), used]
      )
    }

    it('402 when remaining < 5 (would cost more than the user has)', async () => {
      const { TIERS } = await import('../../../shared/config/tiers')
      const u = await createUser()
      // Free cap is 100; seed 96 used → 4 remaining (< 5, fails pre-check).
      await seedUsage(`user:${u.id}`, TIERS.free.interactionsPerMonth - 4)
      const client = await loggedInClient(u.id)
      const res = await client.post('/api/ai/transcribe', {
        audio: MIN_VALID_AUDIO_B64,
        mimeType: VALID_MIME
      })
      expect(res.status).toBe(402)
    })

    it('402 body carries the new error contract: code + messageKey + recovery (upgrade CTA wiring)', async () => {
      // The unified error-handling work added a structured shape to
      // server errors so the client toast can render an Upgrade button
      // routing to /pricing without per-endpoint code. Pin that the
      // wire format matches what useErrorHandler reads.
      const { TIERS } = await import('../../../shared/config/tiers')
      const u = await createUser()
      await seedUsage(`user:${u.id}`, TIERS.free.interactionsPerMonth - 4)
      const client = await loggedInClient(u.id)
      const res = await client.post('/api/ai/transcribe', {
        audio: MIN_VALID_AUDIO_B64,
        mimeType: VALID_MIME
      })
      const body = await res.json() as {
        data?: {
          code?: string
          messageKey?: string
          recovery?: { kind?: string, href?: string, labelKey?: string }
          plan?: string
          remaining?: number
        }
      }
      expect(body.data?.code).toBe('ai/budget-exhausted')
      expect(body.data?.messageKey).toBe('ai.budgetExhaustedDescription')
      expect(body.data?.recovery).toEqual({
        kind: 'link', href: '/pricing', labelKey: 'ai.upgradeCta'
      })
      // Diagnostic fields useful for future analytics.
      expect(body.data?.plan).toBe('free')
      expect(body.data?.remaining).toBe(4)
    })

    it('STT is NOT called when pre-check fires — no cost incurred for exhausted users', async () => {
      // Indirect proof: with a dummy API key, an exhausted-user
      // request returns 402 (pre-check) — NOT 502 (Cloud STT
      // upstream error). If the pre-check ever moved AFTER the STT
      // call, an exhausted user's request would hit Google, return
      // a real-cost response, and the over-cap path would fire.
      // Pin the pre-check ordering by status code.
      const { TIERS } = await import('../../../shared/config/tiers')
      const u = await createUser()
      await seedUsage(`user:${u.id}`, TIERS.free.interactionsPerMonth - 4)
      const client = await loggedInClient(u.id)
      const res = await client.post('/api/ai/transcribe', {
        audio: MIN_VALID_AUDIO_B64,
        mimeType: VALID_MIME
      })
      expect(res.status).toBe(402)
      expect(res.status).not.toBe(502)
    })

    it('with EXACTLY 5 remaining, the pre-check passes (boundary is `< 5`, not `<=`)', async () => {
      // Pin the boundary. A user with exactly 5 left should be allowed
      // to start one last 60s clip. The actual STT call may fail (we
      // use a dummy API key), but it should NOT 402.
      const { TIERS } = await import('../../../shared/config/tiers')
      const u = await createUser()
      await seedUsage(`user:${u.id}`, TIERS.free.interactionsPerMonth - 5)
      const client = await loggedInClient(u.id)
      const res = await client.post('/api/ai/transcribe', {
        audio: MIN_VALID_AUDIO_B64,
        mimeType: VALID_MIME
      })
      expect(res.status).not.toBe(402)
    })
  })

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
