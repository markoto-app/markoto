import { describe, it, expect } from 'vitest'
import en from '../../../i18n/locales/en.json'
import de from '../../../i18n/locales/de.json'
import fr from '../../../i18n/locales/fr.json'
import es from '../../../i18n/locales/es.json'
import ja from '../../../i18n/locales/ja.json'
import zh from '../../../i18n/locales/zh.json'
import { URL_REFUSAL_CODES, VERIFY_CODES, AI_CAPABILITIES, codeKey } from '../../../shared/ai/providers'

// Bring-your-own-key settings + call-to-action strings. Walks the
// whole `aiProvider` subtree of the English file: every leaf must exist
// as a non-empty string in all six locales, and non-English locales
// must not just copy the English text. Also pins that every outcome
// code the server can return has a message (the server sends
// `aiProvider.verify.<code>` / `aiProvider.urlRefused.<code>` keys).

const LOCALES: Record<string, unknown> = { en, de, fr, es, ja, zh }

// Product / brand names that are legitimately identical everywhere.
const MAY_MATCH_ENGLISH = new Set<string>([])

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

const KEYS = leafPaths(resolve(en, 'aiProvider'), 'aiProvider')

describe('aiProvider i18n keys', () => {
  it('the English subtree exists and is non-trivial', () => {
    expect(KEYS.length).toBeGreaterThan(40)
  })

  it('covers every server outcome code and capability', () => {
    for (const code of VERIFY_CODES) expect(KEYS).toContain(`aiProvider.verify.${codeKey(code)}`)
    for (const code of URL_REFUSAL_CODES) expect(KEYS).toContain(`aiProvider.urlRefused.${codeKey(code)}`)
    for (const cap of AI_CAPABILITIES) {
      expect(KEYS).toContain(`aiProvider.capability.${cap}.title`)
      expect(KEYS).toContain(`aiProvider.missing.${cap}`)
    }
  })

  for (const [locale, messages] of Object.entries(LOCALES)) {
    it(`${locale}: every key resolves to a non-empty string`, () => {
      for (const key of KEYS) {
        const value = resolve(messages, key)
        expect(typeof value, `${locale}:${key}`).toBe('string')
        expect(value, `${locale}:${key}`).not.toBe('')
      }
    })
    if (locale === 'en') continue
    it(`${locale}: values are translated, not copied from English`, () => {
      for (const key of KEYS) {
        if (MAY_MATCH_ENGLISH.has(key)) continue
        expect(resolve(messages, key), `${locale}:${key}`).not.toBe(resolve(en, key))
      }
    })
  }
})
