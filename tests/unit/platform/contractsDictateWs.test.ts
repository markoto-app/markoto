import { describe, it, expect } from 'vitest'
import {
  encodeServerFrame,
  encodeClientFrame,
  DICTATE_SERVER_FRAME_TYPES,
  DICTATE_CLIENT_FRAME_TYPES,
  type DictateServerFrame,
  type DictateClientFrame
} from '~~/shared/contracts/dictateWs'

// Contract tests for the dictate WS frame schema. Same shape as the
// other contract tests: pin literal type values, exercise round-trip
// JSON encoding/decoding, and verify the discriminated union narrows
// properly.
//
// Why these matter even though the protocol is "just JSON": the
// server's `peer.send(JSON.stringify(...))` and the client's
// `JSON.parse(...) as { type: string, ... }` were each free-form.
// A typo on either side produced a silently-degraded session, the
// user saw "transcripts didn't appear" with no error. Routing both
// through `encode*Frame` + the discriminated union forces the TS
// compiler to flag the typo at PR time.

describe('DICTATE_SERVER_FRAME_TYPES', () => {
  it('lists every server-frame type', () => {
    expect(DICTATE_SERVER_FRAME_TYPES).toEqual([
      'hello',
      'ready',
      'partial',
      'final',
      'error',
      'budget-exhausted',
      'session-cap',
      'idle-timeout',
      'done'
    ])
  })
})

describe('DICTATE_CLIENT_FRAME_TYPES', () => {
  it('lists every client-frame type', () => {
    expect(DICTATE_CLIENT_FRAME_TYPES).toEqual(['auth', 'stop'])
  })
})

describe('encodeServerFrame', () => {
  it('encodes every server-frame variant to valid JSON with the type discriminator', () => {
    const frames: DictateServerFrame[] = [
      { type: 'hello' },
      { type: 'ready' },
      { type: 'partial', text: 'hello world' },
      { type: 'final', text: 'finalised text.' },
      { type: 'error', message: 'Auth timeout' },
      { type: 'budget-exhausted', remaining: 0 },
      { type: 'budget-exhausted', remaining: 0, reason: 'interactions' },
      { type: 'session-cap' },
      { type: 'idle-timeout' },
      { type: 'done' }
    ]
    for (const frame of frames) {
      const encoded = encodeServerFrame(frame)
      const decoded = JSON.parse(encoded)
      expect(decoded.type).toBe(frame.type)
    }
  })

  it('round-trips text payloads losslessly (preserves UTF-8 + special chars)', () => {
    const frame: DictateServerFrame = { type: 'final', text: 'Hello 你好 🎉 «quotes»' }
    const decoded = JSON.parse(encodeServerFrame(frame))
    expect(decoded.text).toBe('Hello 你好 🎉 «quotes»')
  })

  it('preserves the budget-exhausted `reason` discriminator when present', () => {
    const audio = encodeServerFrame({ type: 'budget-exhausted', remaining: 12345 })
    expect(JSON.parse(audio)).toEqual({ type: 'budget-exhausted', remaining: 12345 })

    const interactions = encodeServerFrame({ type: 'budget-exhausted', remaining: 0, reason: 'interactions' })
    expect(JSON.parse(interactions)).toEqual({ type: 'budget-exhausted', remaining: 0, reason: 'interactions' })
  })
})

describe('encodeClientFrame', () => {
  it('encodes auth + stop frames to valid JSON', () => {
    const auth: DictateClientFrame = { type: 'auth', token: 'jwt.value.here' }
    expect(JSON.parse(encodeClientFrame(auth))).toEqual({
      type: 'auth',
      token: 'jwt.value.here'
    })

    const authWithLang: DictateClientFrame = { type: 'auth', token: 't', languageCode: 'de-DE' }
    expect(JSON.parse(encodeClientFrame(authWithLang))).toEqual({
      type: 'auth',
      token: 't',
      languageCode: 'de-DE'
    })

    const stop: DictateClientFrame = { type: 'stop' }
    expect(JSON.parse(encodeClientFrame(stop))).toEqual({ type: 'stop' })
  })
})

describe('discriminated union narrowing', () => {
  it('TS narrows server frames by their `type` field', () => {
    // This test is mostly compiled away, the assertions are runtime
    // sanity checks. The real value is that this file fails to
    // typecheck if the union narrowing breaks. If `case 'final'`
    // doesn't narrow `frame.text` to `string`, the TS compiler
    // catches it.
    const frames: DictateServerFrame[] = [
      { type: 'final', text: 'hi' },
      { type: 'partial', text: 'hi' },
      { type: 'budget-exhausted', remaining: 0 }
    ]
    // Each case reads the field only its variant has; the map collects the runtime types so one assertion
    // covers every frame (an assertion inside the switch would be conditional).
    const payloadTypes = frames.map((frame) => {
      switch (frame.type) {
        case 'final':
        case 'partial':
          return typeof frame.text
        case 'budget-exhausted':
          return typeof frame.remaining
        default:
          // unreachable for our test fixtures, but the default branch
          // existence is what makes the switch type-exhaustive.
          return 'unreachable'
      }
    })
    expect(payloadTypes).toEqual(['string', 'string', 'number'])
  })
})
