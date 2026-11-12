import { describe, it, expect } from 'vitest'
import { tryParseControl, normalizeLanguageCode } from '../../../server/utils/agentic/dictateHelpers'

// Pure helpers from the dictation route. Testing the routing layer's
// text-vs-binary detection is load-bearing: crossws delivers text as
// Buffer, so the naive `typeof rawData === 'string'` check never
// fires. A regression that breaks `tryParseControl` would silently
// route every control frame as audio, failures only surface when a
// user tries to stop and the stream doesn't respond.

// Minimal shim of crossws's Message class: just the two members we
// touch. Real messages have more, `uint8Array()`, `blob()`, etc.
// but they're lazy and tryParseControl doesn't reach for them.
function msg(raw: Buffer | string): { rawData: unknown, text(): string } {
  return {
    rawData: raw,
    text() {
      return typeof raw === 'string' ? raw : raw.toString('utf8')
    }
  }
}

describe('tryParseControl', () => {
  describe('fast path: non-JSON first byte', () => {
    it('returns null for a binary PCM chunk whose first byte is not {', () => {
      // A typical int16 sample, random first byte, virtually never 0x7B.
      expect(tryParseControl(msg(Buffer.from([0x00, 0x7F, 0xFF, 0x10])))).toBeNull()
    })

    it('returns null for an empty buffer', () => {
      expect(tryParseControl(msg(Buffer.alloc(0)))).toBeNull()
    })

    it('returns null for a Uint8Array that is NOT a Buffer', () => {
      // Direct Uint8Array (not Buffer.isBuffer), the helper has a
      // separate branch for this path. Important because Nitro's
      // WebStream polyfills occasionally deliver Uint8Arrays rather
      // than Node Buffers.
      const u8 = new Uint8Array([0x00, 0xFF, 0x10])
      expect(tryParseControl(msg(u8 as unknown as Buffer))).toBeNull()
    })
  })

  describe('json parse path', () => {
    it('parses a valid auth control frame from Buffer', () => {
      const out = tryParseControl(msg(Buffer.from('{"type":"auth","token":"abc"}')))
      expect(out).toEqual({ type: 'auth', token: 'abc', languageCode: undefined })
    })

    it('parses a valid stop control frame from Buffer', () => {
      const out = tryParseControl(msg(Buffer.from('{"type":"stop"}')))
      expect(out).toEqual({ type: 'stop', token: undefined, languageCode: undefined })
    })

    it('carries through languageCode from auth', () => {
      const out = tryParseControl(msg(Buffer.from('{"type":"auth","token":"t","languageCode":"de-DE"}')))
      expect(out).toEqual({ type: 'auth', token: 't', languageCode: 'de-DE' })
    })

    it('returns null for JSON with an unknown type', () => {
      // Whitelist matters: a random PCM chunk that coincidentally
      // starts with { and parses as valid JSON ({"type":"partial"})
      // must NOT be routed as control. The whitelist keeps audio and
      // control paths cleanly separated.
      expect(tryParseControl(msg(Buffer.from('{"type":"partial"}')))).toBeNull()
    })

    it('returns null for malformed JSON starting with {', () => {
      expect(tryParseControl(msg(Buffer.from('{not json')))).toBeNull()
    })

    it('returns null for a JSON array (not an object)', () => {
      // A chunk starting with [ would fail the startsWith('{') check
      // anyway, but a crafted payload like `{}` followed by array
      // contents shouldn't slip through.
      expect(tryParseControl(msg(Buffer.from('{')))).toBeNull()
    })

    it('accepts actual string rawData (fallback path)', () => {
      // The fast-path byte peek is skipped when rawData is already a
      // string. Some adapters might deliver text frames this way.
      const out = tryParseControl(msg('{"type":"stop"}'))
      expect(out).toEqual({ type: 'stop', token: undefined, languageCode: undefined })
    })
  })
})

describe('normalizeLanguageCode', () => {
  it('maps short ISO 639-1 codes to BCP-47', () => {
    expect(normalizeLanguageCode('en')).toBe('en-US')
    expect(normalizeLanguageCode('de')).toBe('de-DE')
    expect(normalizeLanguageCode('fr')).toBe('fr-FR')
    expect(normalizeLanguageCode('es')).toBe('es-ES')
    expect(normalizeLanguageCode('ja')).toBe('ja-JP')
    expect(normalizeLanguageCode('zh')).toBe('zh-CN')
  })

  it('passes through BCP-47 tags unchanged', () => {
    // Important for users who want a specific dialect like en-GB or
    // de-CH: forcing en-US would silently degrade accuracy.
    expect(normalizeLanguageCode('de-CH')).toBe('de-CH')
    expect(normalizeLanguageCode('en-GB')).toBe('en-GB')
    expect(normalizeLanguageCode('pt-BR')).toBe('pt-BR')
  })

  it('is case-insensitive on the short form', () => {
    expect(normalizeLanguageCode('EN')).toBe('en-US')
    expect(normalizeLanguageCode('De')).toBe('de-DE')
  })

  it('falls back to en-US on unknown input', () => {
    expect(normalizeLanguageCode('xx')).toBe('en-US')
    expect(normalizeLanguageCode('garbage')).toBe('en-US')
    expect(normalizeLanguageCode('')).toBe('en-US')
  })

  it('handles non-string input', () => {
    // A malformed client could send a number or object; the
    // normalizer never throws, always returns a valid language code.
    expect(normalizeLanguageCode(undefined)).toBe('en-US')
    expect(normalizeLanguageCode(null)).toBe('en-US')
    expect(normalizeLanguageCode(42)).toBe('en-US')
    expect(normalizeLanguageCode({})).toBe('en-US')
  })

  it('trims whitespace before matching', () => {
    expect(normalizeLanguageCode('  de  ')).toBe('de-DE')
  })
})
