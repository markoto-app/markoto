import { describe, it, expect } from 'vitest'
import en from '../../../i18n/locales/en.json'
import de from '../../../i18n/locales/de.json'
import fr from '../../../i18n/locales/fr.json'
import es from '../../../i18n/locales/es.json'
import ja from '../../../i18n/locales/ja.json'
import zh from '../../../i18n/locales/zh.json'

// The pricing page (SEO-3): every string it renders must exist in all
// six locales, be translated (not an English copy), keep the plural
// forms the counts rely on, and follow the wording rules (German "ss",
// never "ß"; "source-available", never "open source").

const LOCALES: Record<string, unknown> = { en, de, fr, es, ja, zh }

function resolve(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, seg) => {
    if (acc && typeof acc === 'object' && seg in acc) {
      return (acc as Record<string, unknown>)[seg]
    }
    return undefined
  }, obj)
}

function leaves(obj: unknown, prefix: string): string[] {
  if (typeof obj !== 'object' || obj === null) return [prefix]
  return Object.entries(obj).flatMap(([key, value]) => leaves(value, `${prefix}.${key}`))
}

const GROUPS = ['price', 'selfHosted', 'anon', 'freeAccount', 'paid', 'instance', 'count', 'compare', 'faq']
const KEYS = GROUPS.flatMap(group => leaves(resolve(en, `pricing.${group}`), `pricing.${group}`))

// Plural messages: "one | other" in the languages that inflect.
const PLURAL_KEYS = [
  'pricing.anon.retention',
  'pricing.count.aiPoints',
  'pricing.count.workspaces',
  'pricing.count.knowledgeFiles',
  'pricing.compare.anonRetention',
  'pricing.faq.anonA'
]

// Same word in several languages (product terms, proper names).
const MAY_MATCH_ENGLISH = new Set(['pricing.compare.documents', 'pricing.faq.title'])

describe('pricing i18n keys', () => {
  it('finds the pricing groups in English', () => {
    expect(KEYS.length).toBeGreaterThan(50)
  })

  for (const [locale, messages] of Object.entries(LOCALES)) {
    it(`${locale}: every key resolves to a non-empty string`, () => {
      for (const key of KEYS) {
        const value = resolve(messages, key)
        expect(typeof value, `${locale}:${key}`).toBe('string')
        expect(value, `${locale}:${key}`).not.toBe('')
      }
    })

    it(`${locale}: says "source-available", never "open source"`, () => {
      const text = JSON.stringify(resolve(messages, 'pricing'))
      expect(text.toLowerCase()).not.toMatch(/open[ -]source|open-source/)
      expect(String(resolve(messages, 'pricing.selfHosted.licence')).toLowerCase()).toContain('source-available')
    })
  }

  for (const locale of ['de', 'fr', 'es', 'ja', 'zh']) {
    it(`${locale}: values are translated, not English copies`, () => {
      for (const key of KEYS) {
        if (MAY_MATCH_ENGLISH.has(key)) continue
        expect(resolve(LOCALES[locale], key), `${locale}:${key}`).not.toBe(resolve(en, key))
      }
    })
  }

  for (const locale of ['en', 'de', 'fr', 'es']) {
    it(`${locale}: plural messages have a singular and a plural form`, () => {
      for (const key of PLURAL_KEYS) {
        const forms = String(resolve(LOCALES[locale], key)).split('|')
        expect(forms, `${locale}:${key}`).toHaveLength(2)
        for (const form of forms) expect(form, `${locale}:${key}`).toContain('{n}')
      }
    })
  }

  it('de: writes "ss", never "ß", on the pricing page', () => {
    expect(JSON.stringify(resolve(de, 'pricing'))).not.toContain('ß')
  })
})
