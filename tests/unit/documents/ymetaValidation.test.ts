import { describe, it, expect } from 'vitest'
import {
  isValidMetaValue,
  isBoundedJsonValue,
  clampMetaString
} from '../../../shared/utils/documents/ymetaValidation'
import { DOC_DESCRIPTION_MAX_LENGTH, DOC_TITLE_MAX_LENGTH } from '../../../shared/config/docCreate'
import { defaultTheme } from '../../../shared/utils/theme/defaultTheme'

// The ymeta contract shared by PUT /meta and the sync server's WebSocket
// guard. A value that fails here is refused on both paths.

describe('isValidMetaValue', () => {
  it('bounds title / description / language / templateId length', () => {
    expect(isValidMetaValue('title', 'a'.repeat(DOC_TITLE_MAX_LENGTH))).toBe(true)
    expect(isValidMetaValue('title', 'a'.repeat(DOC_TITLE_MAX_LENGTH + 1))).toBe(false)
    expect(isValidMetaValue('title', 5)).toBe(false)
    expect(isValidMetaValue('description', 'd'.repeat(DOC_DESCRIPTION_MAX_LENGTH + 1))).toBe(false)
    expect(isValidMetaValue('language', 'Schwiizerdütsch')).toBe(true)
    expect(isValidMetaValue('language', 'l'.repeat(51))).toBe(false)
    expect(isValidMetaValue('templateId', 'blank')).toBe(true)
  })

  it('only accepts known audiences', () => {
    expect(isValidMetaValue('audience', 'casual')).toBe(true)
    expect(isValidMetaValue('audience', 'pirate')).toBe(false)
  })

  it('accepts a valid theme and rejects schema failures', () => {
    expect(isValidMetaValue('theme', defaultTheme)).toBe(true)
    expect(isValidMetaValue('theme', { ...defaultTheme, extra: 1 })).toBe(false)
    expect(isValidMetaValue('theme', 'dark')).toBe(false)
  })

  it('rejects a deeply nested theme without recursing', () => {
    let deep: Record<string, unknown> = {}
    for (let i = 0; i < 100_000; i++) deep = { n: deep }
    expect(isValidMetaValue('theme', deep)).toBe(false)
  })

  it('accepts only a boolean for the deletion flag', () => {
    expect(isValidMetaValue('_deleted', true)).toBe(true)
    expect(isValidMetaValue('_deleted', 'yes')).toBe(false)
  })

  it('bounds values under unknown keys', () => {
    expect(isValidMetaValue('newKey', { a: [1, 2, 'x'] })).toBe(true)
    expect(isValidMetaValue('newKey', 'x'.repeat(5000))).toBe(false)
    expect(isValidMetaValue('newKey', { a: { b: { c: { d: { e: 1 } } } } })).toBe(false)
  })
})

describe('isBoundedJsonValue', () => {
  it('rejects non-JSON values', () => {
    const bounds = { maxDepth: 4, maxNodes: 10 }
    expect(isBoundedJsonValue(Number.NaN, bounds)).toBe(false)
    expect(isBoundedJsonValue(new Map(), bounds)).toBe(false)
    expect(isBoundedJsonValue(() => 1, bounds)).toBe(false)
    expect(isBoundedJsonValue({ a: undefined }, bounds)).toBe(false)
  })

  it('counts nodes', () => {
    expect(isBoundedJsonValue(new Array(20).fill(1), { maxDepth: 4, maxNodes: 10 })).toBe(false)
  })
})

describe('clampMetaString', () => {
  it('cuts over-long values to the enforced bound', () => {
    expect(clampMetaString('title', 't'.repeat(300))).toHaveLength(DOC_TITLE_MAX_LENGTH)
    expect(clampMetaString('language', 'de')).toBe('de')
  })
})

describe('isValidMetaValue: theme contract stays in lockstep with themeValidation', () => {
  it('accepts a publication date and the "document" diagram colours, rejects a bad date', () => {
    const ok = structuredClone(defaultTheme)
    ok.cover.date = '2026-10-29'
    ok.mermaid.theme = 'document'
    expect(isValidMetaValue('theme', ok)).toBe(true)
    const bad = structuredClone(defaultTheme)
    bad.cover.date = '2026-13-01'
    expect(isValidMetaValue('theme', bad)).toBe(false)
  })
})
