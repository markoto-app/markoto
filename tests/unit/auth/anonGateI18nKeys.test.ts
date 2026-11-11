import { describe, it, expect } from 'vitest'
import en from '../../../i18n/locales/en.json'
import de from '../../../i18n/locales/de.json'
import fr from '../../../i18n/locales/fr.json'
import es from '../../../i18n/locales/es.json'
import ja from '../../../i18n/locales/ja.json'
import zh from '../../../i18n/locales/zh.json'
import { REPORT_CATEGORIES } from '../../../shared/config/moderation'
import enErrors from '../../../i18n/locales/errors/en.json'
import deErrors from '../../../i18n/locales/errors/de.json'
import frErrors from '../../../i18n/locales/errors/fr.json'
import esErrors from '../../../i18n/locales/errors/es.json'
import jaErrors from '../../../i18n/locales/errors/ja.json'
import zhErrors from '../../../i18n/locales/errors/zh.json'

// Anonymous gate + user-content bar + report form strings: every English
// leaf exists as a non-empty string in all six locales, and the
// translations are not copies of the English text. The refusals the form
// shows are the texts of their codes (`apiErrors.abuse.*`, `apiErrors.anon-gate.*`),
// pinned as translated too.

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
      'legal.abuse.errors.title', 'legal.abuse.errors.generic',
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

// The report form shows these through the error handler (by code), so a
// non-English reader must get them in their language.
describe('report form + anonymous gate refusals are translated by code', () => {
  const ERRORS: Record<string, { apiErrors: Record<string, Record<string, string>> }> = { de: deErrors, fr: frErrors, es: esErrors, ja: jaErrors, zh: zhErrors }
  // What POST /api/abuse-reports answers (the admin triage codes are an English-only admin page).
  const FORM_ABUSE_CODES = ['rate-limited', 'login-required', 'invalid-category', 'url-required', 'body-too-short', 'body-too-long', 'good-faith-required', 'invalid-email', 'contact-required']
  const english = (enErrors as { apiErrors: Record<string, Record<string, string>> }).apiErrors
  for (const [locale, catalog] of Object.entries(ERRORS)) {
    it(`${locale}: the form's abuse/* codes and every anon-gate/* code are not copies of the English text`, () => {
      const shown = [
        ...FORM_ABUSE_CODES.map(slug => ['abuse', slug] as const),
        ...Object.keys(english['anon-gate']!).map(slug => ['anon-gate', slug] as const)
      ]
      for (const [ns, slug] of shown) {
        expect(catalog.apiErrors[ns]?.[slug], `${locale}:${ns}/${slug}`).toBeTruthy()
        expect(catalog.apiErrors[ns]?.[slug], `${locale}:${ns}/${slug}`).not.toBe(english[ns]![slug])
      }
    })
  }
})
