import { describe, it, expect } from 'vitest'
import en from '../../../i18n/locales/en.json'
import de from '../../../i18n/locales/de.json'
import fr from '../../../i18n/locales/fr.json'
import es from '../../../i18n/locales/es.json'
import ja from '../../../i18n/locales/ja.json'
import zh from '../../../i18n/locales/zh.json'
import { REPORT_CATEGORIES } from '../../../shared/config/moderation'

// Anonymous gate + user-content bar + report form strings: every English
// leaf exists as a non-empty string in all six locales, and the
// translations are not copies of the English text. Also pins the keys
// the server sends as `messageKey`.

const LOCALES: Record<string, unknown> = { en, de, fr, es, ja, zh }
const SUBTREES = ['anonGate', 'userContent', 'legal.abuse']

// Words that are legitimately the same in English and that language.
const MAY_MATCH_ENGLISH = new Set<string>([
  'de:legal.abuse.nameLabel'
])

function resolve(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, seg) => {
    if (acc && typeof acc === 'object' && seg in acc) {
      return (acc as Record<string, unknown>)[seg]
    }
    return undefined
  }, obj)
}

function leafPaths(obj: unknown, prefix: string): string[] {
  if (typeof obj !== 'object' || obj === null) return [prefix]
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => leafPaths(v, `${prefix}.${k}`))
}

const KEYS = SUBTREES.flatMap(s => leafPaths(resolve(en, s), s))

describe('anonymous gate + report form i18n', () => {
  it('has the keys the components and the server use', () => {
    for (const key of [
      'anonGate.accept', 'anonGate.termsLink', 'anonGate.privacyNote', 'anonGate.pointRetention',
      'anonGate.continue', 'anonGate.errors.botCheck', 'anonGate.errors.termsRequired',
      'anonGate.errors.unavailable', 'anonGate.errors.rateLimited',
      'userContent.notice', 'userContent.report',
      'legal.abuse.goodFaith', 'legal.abuse.urlLabel', 'legal.abuse.contactOptionalCsam',
      'legal.abuse.errors.rateLimited', 'legal.abuse.errors.loginRequired', 'legal.abuse.errors.category',
      'legal.abuse.errors.urlRequired', 'legal.abuse.errors.bodyTooShort', 'legal.abuse.errors.bodyTooLong',
      'legal.abuse.errors.goodFaith', 'legal.abuse.errors.email', 'legal.abuse.errors.contactRequired',
      ...REPORT_CATEGORIES.map(c => `legal.abuse.category.${c}`)
    ]) {
      expect(KEYS, key).toContain(key)
    }
  })

  it('keeps the placeholders the templates fill', () => {
    expect(resolve(en, 'anonGate.accept')).toMatch(/\{terms\}.*\{age\}/)
    expect(resolve(en, 'anonGate.pointRetention')).toContain('{days}')
  })

  for (const [locale, messages] of Object.entries(LOCALES)) {
    it(`${locale}: every key is a non-empty string with the same placeholders`, () => {
      for (const key of KEYS) {
        const value = resolve(messages, key)
        expect(typeof value, `${locale}:${key}`).toBe('string')
        expect(value, `${locale}:${key}`).not.toBe('')
        const placeholders = (s: unknown) => String(s).match(/\{\w+\}/g)?.sort() ?? []
        expect(placeholders(value), `${locale}:${key}`).toEqual(placeholders(resolve(en, key)))
      }
    })
    if (locale === 'en') continue
    it(`${locale}: translated, not copied`, () => {
      for (const key of KEYS) {
        if (MAY_MATCH_ENGLISH.has(`${locale}:${key}`)) continue
        expect(resolve(messages, key), `${locale}:${key}`).not.toBe(resolve(en, key))
      }
    })
  }
})
