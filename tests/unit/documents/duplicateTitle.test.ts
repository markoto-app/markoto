import { describe, it, expect, vi } from 'vitest'
import { asAppLocale, duplicateTitle, DUPLICATE_TITLE_WORDS } from '../../../shared/utils/documents/duplicateTitle'
import { requestLocale } from '../../../server/utils/platform/requestLocale'
import en from '../../../i18n/locales/en.json'
import de from '../../../i18n/locales/de.json'
import fr from '../../../i18n/locales/fr.json'
import es from '../../../i18n/locales/es.json'
import ja from '../../../i18n/locales/ja.json'
import zh from '../../../i18n/locales/zh.json'

/** Hand a deliberately partial object to a typed parameter. */
const unsafe = (v: unknown): never => v as never

const cookies = vi.hoisted(() => ({ value: undefined as string | undefined }))
const headers = vi.hoisted(() => ({ value: undefined as string | undefined }))
vi.mock('h3', () => ({
  getCookie: () => cookies.value,
  getRequestHeader: () => headers.value
}))

const LOCALES = { en, de, fr, es, ja, zh } as const

describe('duplicateTitle', () => {
  it('names the copy in the caller language', () => {
    expect(duplicateTitle('Bericht', 'de')).toBe('Kopie von Bericht')
    expect(duplicateTitle('Report', 'en')).toBe('Copy of Report')
    expect(duplicateTitle('Rapport', 'fr-CH')).toBe('Copie de Rapport')
    expect(duplicateTitle('Informe', 'es')).toBe('Copia de Informe')
    expect(duplicateTitle('報告', 'ja')).toBe('報告 のコピー')
    expect(duplicateTitle('报告', 'zh')).toBe('报告 的副本')
  })

  it('falls back to English and to an untitled source', () => {
    expect(duplicateTitle('Doc', 'xx')).toBe('Copy of Doc')
    expect(duplicateTitle('Doc', null)).toBe('Copy of Doc')
    expect(duplicateTitle(null, 'de')).toBe('Kopie von Unbenannt')
    expect(duplicateTitle('   ', undefined)).toBe('Copy of Untitled')
  })

  it('stays within 255 characters', () => {
    expect(duplicateTitle('x'.repeat(400), 'en')).toHaveLength(255)
  })

  it('recognises UI locales only', () => {
    expect(asAppLocale('DE_ch')).toBe('de')
    expect(asAppLocale('it')).toBeNull()
    expect(asAppLocale(undefined)).toBeNull()
  })

  it('matches the strings the editor shows through i18n', () => {
    for (const [code, messages] of Object.entries(LOCALES)) {
      const words = DUPLICATE_TITLE_WORDS[code as keyof typeof DUPLICATE_TITLE_WORDS]
      expect(messages.duplicate.copyOf, code).toBe(words.copyOf)
      expect(messages.editor.untitled, code).toBe(words.untitled)
    }
  })
})

describe('requestLocale', () => {
  const event = unsafe({})

  it('prefers the language cookie, then the account, then Accept-Language', () => {
    cookies.value = 'fr'
    headers.value = 'de-CH,de;q=0.9'
    expect(requestLocale(event, 'es')).toBe('fr')
    cookies.value = undefined
    expect(requestLocale(event, 'es')).toBe('es')
    expect(requestLocale(event)).toBe('de')
    headers.value = 'it-IT,it;q=0.9,ja;q=0.5'
    expect(requestLocale(event)).toBe('ja')
  })

  it('is null when nothing names a UI locale', () => {
    cookies.value = 'xx'
    headers.value = 'it-IT'
    expect(requestLocale(event, 'it')).toBeNull()
    headers.value = undefined
    expect(requestLocale(event)).toBeNull()
  })
})
