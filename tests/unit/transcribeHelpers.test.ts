import { describe, it, expect } from 'vitest'
import { mimeToEncoding } from '../../server/utils/agentic/transcribeHelpers'

// `mimeToEncoding` must stay in lockstep with the transcribe
// endpoint's `ALLOWED_MIME` allowlist — if a MIME passes the allow-
// list but returns null here, the user gets a confusing split
// between "your format isn't supported" and "encoding rejected".
// These tests enforce the coupling.

describe('mimeToEncoding', () => {
  it('maps webm/opus variants to WEBM_OPUS', () => {
    // Chrome / Firefox default output. Base `audio/webm` plus the
    // explicit codec suffix that some browsers append.
    expect(mimeToEncoding('audio/webm')).toBe('WEBM_OPUS')
    expect(mimeToEncoding('audio/webm;codecs=opus')).toBe('WEBM_OPUS')
    expect(mimeToEncoding('AUDIO/WEBM')).toBe('WEBM_OPUS')
  })

  it('maps ogg/opus variants to OGG_OPUS', () => {
    expect(mimeToEncoding('audio/ogg')).toBe('OGG_OPUS')
    expect(mimeToEncoding('audio/ogg;codecs=opus')).toBe('OGG_OPUS')
  })

  it('maps wav variants to LINEAR16', () => {
    expect(mimeToEncoding('audio/wav')).toBe('LINEAR16')
    expect(mimeToEncoding('audio/x-wav')).toBe('LINEAR16')
  })

  it('returns null for MP4 / AAC (Safari)', () => {
    // Cloud STT sync recognize doesn't accept MP4. We reject at the
    // MIME gate upstream — this test pins that contract so a future
    // "let's add Safari support" change has to touch BOTH the
    // allowlist AND this mapper AND the transcoding strategy
    // together.
    expect(mimeToEncoding('audio/mp4')).toBeNull()
    expect(mimeToEncoding('audio/mpeg')).toBeNull()
    expect(mimeToEncoding('audio/mp3')).toBeNull()
  })

  it('returns null for non-audio or unknown MIMEs', () => {
    expect(mimeToEncoding('application/octet-stream')).toBeNull()
    expect(mimeToEncoding('text/plain')).toBeNull()
    expect(mimeToEncoding('audio/flac')).toBeNull()
    expect(mimeToEncoding('')).toBeNull()
  })
})
