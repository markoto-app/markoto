import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import {
  anchorSelector, DESKTOP_TOUR_STEPS, EDITOR_TOUR_DONE, EDITOR_TOUR_STORAGE_KEY,
  editorTourAutoStart, editorTourDone, markEditorTourDone, MOBILE_TOUR_STEPS, TOUR_TYPING_PAUSE_MS, tourTypingWait
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

describe('tourTypingWait', () => {
  it('lets the tour open when nobody typed for the pause', () => {
    expect(tourTypingWait(10_000, 0)).toBe(0)
    expect(tourTypingWait(10_000, 10_000 - TOUR_TYPING_PAUSE_MS)).toBe(0)
  })

  it('waits out the rest of the pause while the user is typing', () => {
    expect(tourTypingWait(10_000, 9_000)).toBe(TOUR_TYPING_PAUSE_MS - 1_000)
    expect(tourTypingWait(10_000, 10_000)).toBe(TOUR_TYPING_PAUSE_MS)
  })
})

describe('EditorTour.vue', () => {
  const source = readFileSync(new URL('../../../app/components/editor/EditorTour.vue', import.meta.url), 'utf8')

  it('never moves focus when the popover opens or closes', () => {
    // A popover that takes focus swallowed a prompt being typed into the AI bar.
    expect(source).toMatch(/onOpenAutoFocus: keepFocus, onCloseAutoFocus: keepFocus/)
  })
})

describe('editorTourAutoStart', () => {
  const base = { localDone: false, loggedIn: true, accountPending: false, accountDone: false }

  it('signed in: the account decides, so a sign-out (cleared localStorage) does not bring it back', () => {
    expect(editorTourAutoStart({ ...base, accountDone: true })).toBe('skip')
    expect(editorTourAutoStart(base)).toBe('show')
  })

  it('signed in: waits for the account status before deciding', () => {
    expect(editorTourAutoStart({ ...base, accountPending: true, accountDone: null })).toBe('wait')
  })

  it('this browser already saw it: skip, signed in or not', () => {
    expect(editorTourAutoStart({ ...base, localDone: true, accountPending: true })).toBe('skip')
    expect(editorTourAutoStart({ ...base, loggedIn: false, localDone: true })).toBe('skip')
  })

  it('anonymous: only the browser flag counts', () => {
    expect(editorTourAutoStart({ localDone: false, loggedIn: false, accountPending: false, accountDone: null })).toBe('show')
  })

  it('signed in but the status failed to load: shows (finishing stores it again)', () => {
    expect(editorTourAutoStart({ ...base, accountDone: null })).toBe('show')
  })
})
