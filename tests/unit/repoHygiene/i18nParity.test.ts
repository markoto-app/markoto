import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Every locale must carry exactly the keys of en.json (the source of truth),
// with the same {placeholders}, a compatible plural-form count and no empty
// values. A missing key silently falls back to English in the UI; a dropped
// placeholder renders a sentence with a hole in it.
const LOCALES = ['en', 'de', 'fr', 'es', 'ja', 'zh'] as const
const SOURCE = 'en'
// Languages without grammatical plural may collapse "a | b" into one form.
const SINGLE_FORM_OK = new Set(['ja', 'zh'])

// Known exceptions today. Shrink-only: fix the translation, delete the entry.
// "<locale>:<key>" -> reason.
const PLURAL_FORM_EXCEPTIONS: Record<string, string> = {
  'de:legal.delete.consequences.deleted.ownedDocs': 'omits the "none" form; en has 3 forms',
  'fr:legal.delete.consequences.deleted.ownedDocs': 'omits the "none" form; en has 3 forms',
  'es:legal.delete.consequences.deleted.ownedDocs': 'omits the "none" form; en has 3 forms'
}

type Flat = Record<string, string>

// Index access without `undefined`: callers only pass keys read from the same map or checked with `in`.
const val = (m: Flat, k: string): string => m[k] ?? ''

function flatten(obj: unknown, prefix = '', out: Flat = {}): Flat {
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out)
    else out[key] = v as string
  }
  return out
}

const dir = join(__dirname, '..', '..', '..', 'i18n', 'locales')
// Each locale is its UI strings plus its API error texts (`errors/<l>.json`, merged by @nuxtjs/i18n).
const messages = Object.fromEntries(
  LOCALES.map(l => [l, flatten({
    ...JSON.parse(readFileSync(join(dir, `${l}.json`), 'utf8')),
    ...JSON.parse(readFileSync(join(dir, 'errors', `${l}.json`), 'utf8'))
  })])
) as Record<(typeof LOCALES)[number], Flat>

const placeholders = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]))].sort()
const forms = (s: string) => s.split('|').length
const source = messages[SOURCE]

describe('i18n locale parity', () => {
  it('only holds string leaves in the source locale', () => {
    expect(Object.entries(source).filter(([, v]) => typeof v !== 'string')).toEqual([])
  })

  for (const locale of LOCALES.filter(l => l !== SOURCE)) {
    describe(`${locale}`, () => {
      const m = messages[locale]

      it('has exactly the keys of en.json', () => {
        const missing = Object.keys(source).filter(k => !(k in m))
        const extra = Object.keys(m).filter(k => !(k in source))
        expect({ missing, extra }).toEqual({ missing: [], extra: [] })
      })

      it('keeps the same placeholders per key', () => {
        const bad = Object.keys(source)
          .filter(k => k in m && placeholders(val(source, k)).join() !== placeholders(val(m, k)).join())
          .map(k => `${k}: en {${placeholders(val(source, k))}} vs {${placeholders(val(m, k))}}`)
        expect(bad).toEqual([])
      })

      it('keeps plural forms consistent', () => {
        const bad = Object.keys(source).filter((k) => {
          if (!(k in m) || PLURAL_FORM_EXCEPTIONS[`${locale}:${k}`]) return false
          const want = forms(val(source, k))
          const got = forms(val(m, k))
          return SINGLE_FORM_OK.has(locale) ? got !== want && got !== 1 : got !== want
        })
        expect(bad).toEqual([])
      })

      it('has no empty values', () => {
        expect(Object.keys(m).filter(k => val(m, k).trim() === '')).toEqual([])
      })
    })
  }

  it('has no stale plural exception', () => {
    const stale = Object.keys(PLURAL_FORM_EXCEPTIONS).filter((id) => {
      const [locale, ...rest] = id.split(':')
      const key = rest.join(':')
      const loc = messages[locale as (typeof LOCALES)[number]]
      return !loc || !(key in loc) || forms(val(loc, key)) === forms(val(source, key))
    })
    expect(stale).toEqual([])
  })

  it('has no empty values in en.json', () => {
    expect(Object.keys(source).filter(k => val(source, k).trim() === '')).toEqual([])
  })
})
