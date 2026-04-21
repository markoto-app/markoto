import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import { createUser } from '../setup/fixtures'

// POST /api/ai/transcribe — validation surface only. The Gemini call
// itself isn't exercised here (tests use a dummy API key) but every
// request passes through the full validation ladder before reaching the
// SDK, so 4xx paths are fully covered.
//
// Happy-path is covered indirectly: if validation lets a request
// through, the Gemini SDK fails with an upstream error — that branch
// does not need integration coverage since it's just the standard
// SDK error-propagation pattern shared with the other AI endpoints.

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

    it('accepts all browser-native MIME types', async () => {
      // Each of these must pass our validation ladder. The test env's
      // dummy Google key means the downstream Gemini call will fail with
      // its own 400 ("API key not valid"), which the SDK propagates
      // back. That's FINE — the assertion just has to distinguish "our
      // mimeType gate rejected this" from "Gemini's upstream failure".
      const user = await createUser()
      const client = await loggedInClient(user.id)
      const cases = [
        'audio/webm',
        'audio/webm;codecs=opus',
        'audio/ogg',
        'audio/mp4',
        'audio/mpeg',
        'audio/mp3',
        'audio/wav'
      ]
      for (const mimeType of cases) {
        const res = await client.post('/api/ai/transcribe', {
          audio: MIN_VALID_AUDIO_B64,
          mimeType
        })
        if (res.status === 400) {
          const body = await res.json() as { message?: string }
          // Only fail if OUR mimeType gate rejected it — Gemini's
          // upstream 400 mentions "API key", not "mimeType".
          if (body.message && /mimeType/i.test(body.message)) {
            throw new Error(`${mimeType} rejected at our gate: ${body.message}`)
          }
        }
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
  })
})
