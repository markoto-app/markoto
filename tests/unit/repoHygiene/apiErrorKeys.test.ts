import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, it, expect } from 'vitest'
import { API_ERRORS, apiErrorMessageKey } from '../../../shared/api/errors'

// The error registry (shared/api/errors/) and its texts
// (i18n/locales/errors/<locale>.json) stay in step: every code has a text in
// every locale, a text interpolates only params the code always carries,
// there are no orphan texts, and no code is thrown under server/ that the
// registry doesn't know.

const ROOT = join(__dirname, '..', '..', '..')
const LOCALES = ['en', 'de', 'fr', 'es', 'ja', 'zh'] as const
/** Client-side texts that are not codes: `fields[].issue` of a validation failure. */
const VALIDATION_PREFIX = 'apiErrors.validation.'

type Flat = Record<string, string>
function flatten(obj: unknown, prefix = '', out: Flat = {}): Flat {
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') flatten(v, key, out)
    else out[key] = v as string
  }
  return out
}
const catalogs = Object.fromEntries(LOCALES.map(l => [l, flatten(JSON.parse(readFileSync(join(ROOT, 'i18n/locales/errors', `${l}.json`), 'utf8')))])) as Record<(typeof LOCALES)[number], Flat>

const placeholders = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]!))]

function requiredParams(code: string): string[] {
  const spec = (API_ERRORS as Record<string, { params?: { shape: Record<string, { safeParse: (v: unknown) => { success: boolean } }> } }>)[code]!
  return Object.entries(spec.params?.shape ?? {}).filter(([, f]) => !f.safeParse(undefined).success).map(([k]) => k)
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('API error registry ↔ locale texts', () => {
  const codes = Object.keys(API_ERRORS)

  it('every code has a text in every locale', () => {
    const missing = LOCALES.flatMap(l => codes.filter(c => !(apiErrorMessageKey(c) in catalogs[l])).map(c => `${l}: ${c}`))
    expect(missing).toEqual([])
  })

  it('a text\'s {placeholders} name only params the code always carries', () => {
    const bad = LOCALES.flatMap(l => codes.flatMap((c) => {
      const text = catalogs[l][apiErrorMessageKey(c)]
      if (text === undefined) return []
      const extra = placeholders(text).filter(p => !requiredParams(c).includes(p))
      return extra.length ? [`${l}: ${c} {${extra.join(', ')}}`] : []
    }))
    expect(bad).toEqual([])
  })

  it('has no orphan texts', () => {
    const known = new Set(codes.map(apiErrorMessageKey))
    const orphans = LOCALES.flatMap(l => Object.keys(catalogs[l]).filter(k => !known.has(k) && !k.startsWith(VALIDATION_PREFIX)).map(k => `${l}: ${k}`))
    expect(orphans).toEqual([])
  })

  it('every error code literal under server/ is registered', () => {
    const unknown: string[] = []
    for (const file of walk(join(ROOT, 'server'))) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/\bcode:\s*'([a-z][a-z0-9-]*\/[a-z0-9-]+)'/g)) {
        if (!(m[1]! in API_ERRORS)) unknown.push(`${relative(ROOT, file)}: ${m[1]}`)
      }
    }
    expect(unknown).toEqual([])
  })

  it('statuses are 4xx/5xx and the extra statuses differ from the main one', () => {
    for (const [code, spec] of Object.entries(API_ERRORS) as Array<[string, { status: number, statuses?: readonly number[] }]>) {
      expect(spec.status, code).toBeGreaterThanOrEqual(400)
      expect(spec.statuses ?? [], code).not.toContain(spec.status)
    }
  })

  it('the validation texts exist in every locale', () => {
    const en = Object.keys(catalogs.en).filter(k => k.startsWith(VALIDATION_PREFIX)).sort()
    expect(en.length).toBeGreaterThan(0)
    for (const l of LOCALES) expect(Object.keys(catalogs[l]).filter(k => k.startsWith(VALIDATION_PREFIX)).sort()).toEqual(en)
  })
})
