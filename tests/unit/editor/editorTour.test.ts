import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import {
  anchorSelector, DESKTOP_TOUR_STEPS, EDITOR_TOUR_DONE, EDITOR_TOUR_STORAGE_KEY,
  editorTourDone, markEditorTourDone, MOBILE_TOUR_STEPS
} from '../../../app/utils/editor/editorTour'

// The first-run editor tour: step data, anchors and the "seen" flag.

const LOCALES = ['en', 'de', 'fr', 'es', 'ja', 'zh']

function lookup(obj: unknown, key: string): unknown {
  let cur: unknown = obj
  for (const part of key.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined
    cur = Reflect.get(cur, part)
  }
  return cur
}

function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() { return data.size },
    clear: () => data.clear(),
    getItem: k => data.get(k) ?? null,
    key: i => [...data.keys()][i] ?? null,
    removeItem: (k) => { data.delete(k) },
    setItem: (k, v) => { data.set(k, v) }
  }
}

describe('editor tour steps', () => {
  it('has 4–6 steps on both layouts', () => {
    for (const steps of [DESKTOP_TOUR_STEPS, MOBILE_TOUR_STEPS]) {
      expect(steps.length).toBeGreaterThanOrEqual(4)
      expect(steps.length).toBeLessThanOrEqual(6)
    }
  })

  it('every step and label key is translated in every locale', () => {
    const keys = new Set<string>(['editorTour.stepOf', 'editorTour.skip', 'editorTour.next', 'editorTour.done'])
    for (const s of [...DESKTOP_TOUR_STEPS, ...MOBILE_TOUR_STEPS]) {
      keys.add(s.titleKey)
      keys.add(s.bodyKey)
      if (s.anchor.kind !== 'testid') keys.add(s.anchor.labelKey)
    }
    for (const locale of LOCALES) {
      const messages: unknown = JSON.parse(readFileSync(new URL(`../../../i18n/locales/${locale}.json`, import.meta.url), 'utf-8'))
      for (const key of keys) {
        const value = lookup(messages, key)
        expect(typeof value === 'string' && value.length > 0, `${locale}: ${key}`).toBe(true)
      }
    }
  })
})

describe('anchorSelector', () => {
  it('builds selectors for each anchor kind, quoting labels', () => {
    expect(anchorSelector({ kind: 'testid', id: 'access-lock-button' }, '')).toBe('[data-testid="access-lock-button"]')
    expect(anchorSelector({ kind: 'mobileTab', labelKey: 'x' }, 'Thème')).toBe('[data-testid="mobile-tab-bar"] button[aria-label="Thème"]')
    expect(anchorSelector({ kind: 'ariaLabel', labelKey: 'x', within: 'header' }, 'Say "hi"')).toBe('header button[aria-label="Say \\"hi\\""]')
  })
})

describe('tour storage', () => {
  it('is not done until marked, then done', () => {
    const storage = memoryStorage()
    expect(editorTourDone(storage)).toBe(false)
    markEditorTourDone(storage)
    expect(storage.getItem(EDITOR_TOUR_STORAGE_KEY)).toBe(EDITOR_TOUR_DONE)
    expect(editorTourDone(storage)).toBe(true)
  })

  it('treats blocked storage as done (no nagging) and never throws', () => {
    const deny = (): never => {
      throw new Error('denied')
    }
    const blocked = { getItem: deny, setItem: deny }
    expect(editorTourDone(blocked)).toBe(true)
    expect(() => markEditorTourDone(blocked)).not.toThrow()
    expect(editorTourDone(null)).toBe(false)
  })
})
