import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  VOXTRAL_SUPPORTED_LANGUAGES,
  isVoxtralSupportedLanguage
} from '../../../shared/languages/voxtralSupport'

// Pinned invariant: every UI locale we ship MUST be in Voxtral's
// supported transcription set. Without this guard a future locale
// addition (e.g. shipping `pl.json` for Polish) silently breaks
// dictation for that audience, Voxtral returns empty transcripts and
// the user sees a mic that "doesn't work" with no error.
//
// When this test fails, two valid responses:
//   1. The new locale IS supported by Voxtral but the constant in
//      `voxtralSupport.ts` was out of date, extend the constant.
//   2. The new locale ISN'T supported. Don't ship the locale OR
//      add a fallback (e.g. UI locale ≠ dictation language for
//      that audience).

const __dirname = dirname(fileURLToPath(import.meta.url))
const localesDir = resolve(__dirname, '../../../i18n/locales')

function shippedLocales(): string[] {
  return readdirSync(localesDir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''))
}

describe('Voxtral language support: invariant guard', () => {
  it('every shipped i18n locale is in Voxtral\'s transcribe-supported set', () => {
    const locales = shippedLocales()
    expect(locales.length).toBeGreaterThan(0) // sanity: dir didn't disappear
    for (const loc of locales) {
      expect(
        isVoxtralSupportedLanguage(loc),
        `i18n locale "${loc}" is shipped but Voxtral doesn't support it. `
        + 'Either add it to VOXTRAL_SUPPORTED_LANGUAGES (verify Mistral model '
        + 'card first) or remove the locale.'
      ).toBe(true)
    }
  })

  it('predicate accepts both bare ISO codes and BCP-47 tags', () => {
    expect(isVoxtralSupportedLanguage('en')).toBe(true)
    expect(isVoxtralSupportedLanguage('en-US')).toBe(true)
    expect(isVoxtralSupportedLanguage('de-DE')).toBe(true)
    expect(isVoxtralSupportedLanguage('zh-Hans')).toBe(true)
  })

  it('predicate rejects unsupported languages cleanly', () => {
    expect(isVoxtralSupportedLanguage('pl')).toBe(false) // Polish
    expect(isVoxtralSupportedLanguage('tr-TR')).toBe(false) // Turkish
    expect(isVoxtralSupportedLanguage('vi')).toBe(false) // Vietnamese
  })

  it('predicate handles malformed input without throwing', () => {
    expect(isVoxtralSupportedLanguage('')).toBe(false)
    expect(isVoxtralSupportedLanguage(null)).toBe(false)
    expect(isVoxtralSupportedLanguage(undefined)).toBe(false)
  })

  it('the supported set is non-empty and contains canonical codes', () => {
    expect(VOXTRAL_SUPPORTED_LANGUAGES.length).toBeGreaterThanOrEqual(13)
    expect(VOXTRAL_SUPPORTED_LANGUAGES).toContain('en')
    expect(VOXTRAL_SUPPORTED_LANGUAGES).toContain('de')
  })
})
