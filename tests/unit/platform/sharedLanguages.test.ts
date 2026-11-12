import { describe, it, expect } from 'vitest'
import {
  LANGUAGE_PRESETS,
  resolveLanguageDisplayName,
  languageBadge,
  isValidLanguage
} from '../../../shared/languages'

describe('shared/languages: LANGUAGE_PRESETS', () => {
  it('contains the 6 curated locales we ship i18n for', () => {
    expect(LANGUAGE_PRESETS).toEqual(['en', 'de', 'fr', 'es', 'ja', 'zh'])
  })
})

describe('resolveLanguageDisplayName', () => {
  it('returns the language as it names itself for ISO codes', () => {
    expect(resolveLanguageDisplayName('en')).toBe('English')
    expect(resolveLanguageDisplayName('de')).toBe('Deutsch')
    expect(resolveLanguageDisplayName('fr')).toBe('français')
    expect(resolveLanguageDisplayName('ja')).toBe('日本語')
  })

  it('returns the literal string for free-text inputs', () => {
    expect(resolveLanguageDisplayName('Schwiizerdütsch')).toBe('Schwiizerdütsch')
    expect(resolveLanguageDisplayName('Romantsch')).toBe('Romantsch')
  })

  it('falls back to "English" on empty input rather than throwing', () => {
    expect(resolveLanguageDisplayName('')).toBe('English')
    expect(resolveLanguageDisplayName('   ')).toBe('English')
  })

  it('does not throw on malformed BCP-47 inputs (spaces, punctuation)', () => {
    // Intl.DisplayNames throws RangeError on tags like "english language"
    // the catch must keep the function pure.
    expect(() => resolveLanguageDisplayName('english language')).not.toThrow()
    expect(resolveLanguageDisplayName('english language')).toBe('english language')
  })
})

describe('languageBadge', () => {
  it('uppercases ISO 2-letter codes', () => {
    expect(languageBadge('en')).toBe('EN')
    expect(languageBadge('de')).toBe('DE')
  })

  it('uppercases ISO 3-letter codes', () => {
    expect(languageBadge('eng')).toBe('ENG')
  })

  it('strips region tags from BCP-47 (`pt-BR` → `PT`)', () => {
    expect(languageBadge('pt-BR')).toBe('PT')
    expect(languageBadge('de-CH')).toBe('DE')
  })

  it('takes first 4 chars of free-text inputs uppercased', () => {
    expect(languageBadge('Schwiizerdütsch')).toBe('SCHW')
    expect(languageBadge('Romantsch')).toBe('ROMA')
  })

  it('falls back to "EN" on empty/whitespace', () => {
    expect(languageBadge('')).toBe('EN')
    expect(languageBadge('   ')).toBe('EN')
  })
})

describe('isValidLanguage', () => {
  it('accepts non-empty strings up to the cap', () => {
    expect(isValidLanguage('en')).toBe(true)
    expect(isValidLanguage('Schwiizerdütsch')).toBe(true)
  })

  it('rejects empty, non-string, or oversized values', () => {
    expect(isValidLanguage('')).toBe(false)
    expect(isValidLanguage('a'.repeat(51))).toBe(false)
    expect(isValidLanguage(null)).toBe(false)
    expect(isValidLanguage(undefined)).toBe(false)
    expect(isValidLanguage(42)).toBe(false)
  })
})
