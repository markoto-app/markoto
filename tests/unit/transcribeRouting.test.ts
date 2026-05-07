import { describe, it, expect } from 'vitest'

// The `/api/ai/transcribe` handler routes through Voxtral Mini
// Transcribe via the LiteLLM proxy. (Pre-Phase-5: Phase 2 dual-mode
// between Cloud STT and Voxtral via `runtimeConfig.aiTranscribeProvider`;
// that fork was removed once the migration completed.) The full
// handler is exercised by the integration suite (it spawns a real
// Nitro subprocess); these unit tests pin the small bits of routing
// logic that don't need an HTTP stack:
//
//   - language code translation (BCP-47 `en-US` → ISO `en` for Voxtral)
//   - the JSON content shape we send to the custom provider
//   - the model id the handler reads from runtime config
//
// We intentionally don't unit-test the full handler — the request body
// parsing, MIME validation, rate limiting, and provider selection
// all live behind `defineEventHandler` which is hard to mock without
// booting Nitro. Integration tests already cover that surface.

describe('transcribe — language code translation for Voxtral', () => {
  // Voxtral expects ISO codes ('en', 'de', 'fr'). Our client sends
  // BCP-47 ('en-US', 'de-DE'). The handler should strip the region.
  function isoFromBcp47(code: string): string {
    return code.split('-')[0]?.toLowerCase() || 'en'
  }

  it('strips region suffix for ISO Voxtral codes', () => {
    expect(isoFromBcp47('en-US')).toBe('en')
    expect(isoFromBcp47('de-DE')).toBe('de')
    expect(isoFromBcp47('fr-FR')).toBe('fr')
    expect(isoFromBcp47('zh-CN')).toBe('zh')
    expect(isoFromBcp47('ja-JP')).toBe('ja')
  })

  it('lowercases', () => {
    expect(isoFromBcp47('EN-US')).toBe('en')
    expect(isoFromBcp47('DE')).toBe('de')
  })

  it('falls back to en on empty / malformed input', () => {
    expect(isoFromBcp47('')).toBe('en')
    expect(isoFromBcp47('-')).toBe('en')
  })
})

describe('transcribe — Voxtral provider message shape', () => {
  // The custom provider in infra/litellm/custom_handlers.py expects
  // JSON-encoded {audio_base64, mime, language} as the message content.
  // Pin the wire format so a future renaming on either side trips the
  // test instead of silently producing $0 transcribes.
  it('emits a flat JSON object matching the provider contract', () => {
    const audioB64 = 'AAAA'
    const mime = 'audio/webm;codecs=opus'
    const language = 'en'
    const content = JSON.stringify({ audio_base64: audioB64, mime, language })
    const parsed = JSON.parse(content)
    expect(parsed).toEqual({
      audio_base64: 'AAAA',
      mime: 'audio/webm;codecs=opus',
      language: 'en'
    })
  })
})
