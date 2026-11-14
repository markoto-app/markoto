import { describe, expect, it } from 'vitest'
import { accountLanguageName, localeDisplayName } from '../../../app/utils/platform/localeName'

const LOCALES = [
  { code: 'en', name: 'English' },
  { code: 'de', name: 'Deutsch' },
  { code: 'ja', name: '日本語' }
]

describe('localeDisplayName', () => {
  it('names a configured language in that language', () => {
    expect(localeDisplayName('de', LOCALES)).toBe('Deutsch')
    expect(localeDisplayName('ja', LOCALES)).toBe('日本語')
  })

  it('matches a regional code by its base language', () => {
    expect(localeDisplayName('de-CH', LOCALES)).toBe('Deutsch')
  })

  it('returns an unknown code as it is', () => {
    expect(localeDisplayName('pt', LOCALES)).toBe('pt')
  })
})

describe('accountLanguageName', () => {
  it('shows the stored language', () => {
    expect(accountLanguageName('en', 'de', LOCALES)).toBe('English')
  })

  it('falls back to the active UI language when none is stored', () => {
    expect(accountLanguageName(null, 'de', LOCALES)).toBe('Deutsch')
    expect(accountLanguageName(undefined, 'de', LOCALES)).toBe('Deutsch')
    expect(accountLanguageName('  ', 'ja', LOCALES)).toBe('日本語')
  })
})
