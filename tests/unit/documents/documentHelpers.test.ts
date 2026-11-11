import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import {
  readThemeFromYmeta,
  canEditTheme,
  docSizeWarning
} from '~~/shared/utils/documents/documentHelpers'
import { defaultTheme } from '~~/shared/utils/theme/defaultTheme'

// Three pure helpers lifted from useDocument.ts. The orchestrator now
// delegates to these, so the invariants live here — once these pass,
// the orchestrator just has to wire them up correctly.

// ═══════════════════════════════════════════════════════════════════════
// readThemeFromYmeta — ymeta.theme → DocTheme (with fallback)
// ═══════════════════════════════════════════════════════════════════════

describe('readThemeFromYmeta', () => {
  function ymap(entries: Record<string, unknown> = {}): Y.Map<unknown> {
    const doc = new Y.Doc()
    const m = doc.getMap<unknown>('meta')
    for (const [k, v] of Object.entries(entries)) m.set(k, v)
    return m
  }

  it('returns defaultTheme when no theme is set', () => {
    expect(readThemeFromYmeta(ymap())).toBe(defaultTheme)
  })

  it('returns defaultTheme for a non-object theme value', () => {
    // Pathological input — Y.Map is typed unknown, so in theory a bad
    // peer could push a string or number. isValidTheme rejects, helper
    // falls back silently.
    expect(readThemeFromYmeta(ymap({ theme: 'not a theme' }))).toBe(defaultTheme)
    expect(readThemeFromYmeta(ymap({ theme: 42 }))).toBe(defaultTheme)
    expect(readThemeFromYmeta(ymap({ theme: null }))).toBe(defaultTheme)
  })

  it('returns defaultTheme for a structurally-invalid theme object', () => {
    expect(readThemeFromYmeta(ymap({ theme: { notARealThemeField: true } }))).toBe(defaultTheme)
  })

  it('returns the stored theme when valid', () => {
    // Use the real default as a known-valid seed so we don't couple to
    // themeValidation specifics.
    const valid = structuredClone(defaultTheme)
    const theme = readThemeFromYmeta(ymap({ theme: valid }))
    expect(theme).toEqual(valid)
    // Reference equality isn't guaranteed because Y.Map may deep-clone
    // on set; content equality is what the orchestrator actually needs.
  })
})

// ═══════════════════════════════════════════════════════════════════════
// canEditTheme — access-mode derivation
// ═══════════════════════════════════════════════════════════════════════

describe('canEditTheme', () => {
  it('read-only blocks editing regardless of ownership', () => {
    expect(canEditTheme({ isReadOnly: true, isOwner: true, hasOwner: true })).toBe(false)
    expect(canEditTheme({ isReadOnly: true, isOwner: false, hasOwner: true })).toBe(false)
    expect(canEditTheme({ isReadOnly: true, isOwner: false, hasOwner: false })).toBe(false)
  })

  it('owner of a writable doc can edit', () => {
    expect(canEditTheme({ isReadOnly: false, isOwner: true, hasOwner: true })).toBe(true)
  })

  it('non-owner on an owned doc cannot edit', () => {
    // Open-view on an owned doc is the typical case here — the JWT
    // grants write access to content but the orchestrator still gates
    // theme on ownership (owner is source of truth for the stored
    // DocTheme row).
    expect(canEditTheme({ isReadOnly: false, isOwner: false, hasOwner: true })).toBe(false)
  })

  it('anonymous viewer on an ownerless doc CAN edit (open-edit liberal default)', () => {
    // Ownerless = anonymous-created doc, default mode open-edit:
    // "anyone can change anything" explicitly includes theme.
    expect(canEditTheme({ isReadOnly: false, isOwner: false, hasOwner: false })).toBe(true)
  })

  it('degenerate: ownerless + isOwner=true (shouldn\'t happen, but behave sanely)', () => {
    // If upstream ever gets into a weird state where hasOwner=false but
    // isOwner=true, the isOwner check wins. Not a bug path — just a
    // pin for the short-circuit ordering.
    expect(canEditTheme({ isReadOnly: false, isOwner: true, hasOwner: false })).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// docSizeWarning — byte count → banner severity
// ═══════════════════════════════════════════════════════════════════════

describe('docSizeWarning', () => {
  const MB = 1024 * 1024

  it('returns null below 5 MB', () => {
    expect(docSizeWarning(0)).toBe(null)
    expect(docSizeWarning(MB)).toBe(null)
    expect(docSizeWarning(5 * MB)).toBe(null) // boundary: exactly 5 MB is NOT a warning (> check)
    expect(docSizeWarning(4.999 * MB)).toBe(null)
  })

  it('returns "warning" between 5 MB (exclusive) and 8 MB (inclusive)', () => {
    expect(docSizeWarning(5 * MB + 1)).toBe('warning')
    expect(docSizeWarning(6 * MB)).toBe('warning')
    expect(docSizeWarning(7.5 * MB)).toBe('warning')
    expect(docSizeWarning(8 * MB)).toBe('warning') // boundary: exactly 8 MB is still warning
  })

  it('returns "critical" above 8 MB', () => {
    expect(docSizeWarning(8 * MB + 1)).toBe('critical')
    expect(docSizeWarning(10 * MB)).toBe('critical')
    expect(docSizeWarning(100 * MB)).toBe('critical')
  })

  it('handles negative bytes gracefully (clamps to null, below threshold)', () => {
    // Shouldn't happen — Y.js encodeStateAsUpdate byteLength is
    // non-negative — but defensive pinning is cheap.
    expect(docSizeWarning(-100)).toBe(null)
  })
})
