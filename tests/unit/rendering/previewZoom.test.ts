import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PREVIEW_ZOOM,
  PREVIEW_ZOOM_MAX,
  PREVIEW_ZOOM_MIN,
  PREVIEW_ZOOM_STORAGE_KEY,
  clampZoom,
  formatZoomPercent,
  loadPreviewZoom,
  parseStoredZoom,
  sameZoomSetting,
  savePreviewZoom,
  settingFromGesture,
  zoomInFrom,
  zoomOutFrom,
  zoomShortcutAction
} from '../../../app/utils/preview/previewZoom'

describe('preview zoom steps', () => {
  it('zooms in from fit width to the next step above what is shown', () => {
    // A step barely above what is shown is skipped (74 % → 100 %, not 75 %).
    expect(zoomInFrom({ mode: 'fit' }, 0.74)).toEqual({ mode: 'scale', scale: 1 })
    expect(zoomOutFrom({ mode: 'fit' }, 0.52)).toEqual({ mode: 'overview' })
    expect(zoomInFrom({ mode: 'fit' }, 0.87)).toEqual({ mode: 'scale', scale: 1 })
    expect(zoomInFrom({ mode: 'fit' }, 1)).toEqual({ mode: 'scale', scale: 1.25 })
    expect(zoomInFrom({ mode: 'fit' }, 0.4)).toEqual({ mode: 'scale', scale: 0.5 })
  })

  it('walks the fixed steps and stops at the largest', () => {
    expect(zoomInFrom({ mode: 'scale', scale: 1 }, 1)).toEqual({ mode: 'scale', scale: 1.25 })
    expect(zoomInFrom({ mode: 'scale', scale: 2 }, 2)).toEqual({ mode: 'scale', scale: 2 })
    // A free (pinched) factor goes to the next step, not one past it.
    expect(zoomInFrom({ mode: 'scale', scale: 1.1 }, 1.1)).toEqual({ mode: 'scale', scale: 1.25 })
    // Beyond the steps (pinched to 260 %): stays where it is.
    expect(zoomInFrom({ mode: 'scale', scale: 2.6 }, 2.6)).toEqual({ mode: 'scale', scale: 2.6 })
  })

  it('zooms out step by step and below the smallest step into the overview', () => {
    expect(zoomOutFrom({ mode: 'scale', scale: 1 }, 1)).toEqual({ mode: 'scale', scale: 0.75 })
    expect(zoomOutFrom({ mode: 'fit' }, 0.87)).toEqual({ mode: 'scale', scale: 0.75 })
    expect(zoomOutFrom({ mode: 'scale', scale: 0.5 }, 0.5)).toEqual({ mode: 'overview' })
    expect(zoomOutFrom({ mode: 'overview' }, 0.2)).toEqual({ mode: 'overview' })
  })

  it('returns from the overview to fit width when zooming in', () => {
    expect(zoomInFrom({ mode: 'overview' }, 0.18)).toEqual({ mode: 'fit' })
  })

  it('treats an unknown effective scale as 100 %', () => {
    expect(zoomInFrom({ mode: 'fit' }, null)).toEqual({ mode: 'scale', scale: 1.25 })
    expect(zoomOutFrom({ mode: 'fit' }, Number.NaN)).toEqual({ mode: 'scale', scale: 0.75 })
  })
})

describe('gestures', () => {
  it('stores a pinched factor, clamped and rounded', () => {
    expect(settingFromGesture(1.234)).toEqual({ mode: 'scale', scale: 1.23 })
    expect(settingFromGesture(9)).toEqual({ mode: 'scale', scale: PREVIEW_ZOOM_MAX })
    expect(settingFromGesture(PREVIEW_ZOOM_MIN)).toEqual({ mode: 'scale', scale: PREVIEW_ZOOM_MIN })
  })

  it('pinching well past the minimum pulls back into the overview', () => {
    expect(settingFromGesture(0.2)).toEqual({ mode: 'overview' })
  })

  it('clampZoom never returns something outside the range', () => {
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(1)
    expect(clampZoom(-3)).toBe(PREVIEW_ZOOM_MIN)
    expect(clampZoom(100)).toBe(PREVIEW_ZOOM_MAX)
  })
})

describe('persistence (per browser)', () => {
  function memoryStorage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial))
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => {
        data.set(k, v)
      }
    }
  }

  it('round-trips every setting', () => {
    for (const setting of [{ mode: 'fit' as const }, { mode: 'overview' as const }, { mode: 'scale' as const, scale: 1.5 }]) {
      const storage = memoryStorage()
      savePreviewZoom(storage, setting)
      expect(loadPreviewZoom(storage)).toEqual(setting)
    }
  })

  it('falls back to fit width for missing, broken or foreign values', () => {
    expect(parseStoredZoom(null)).toEqual(DEFAULT_PREVIEW_ZOOM)
    expect(parseStoredZoom('{nope')).toEqual(DEFAULT_PREVIEW_ZOOM)
    expect(parseStoredZoom('"fit"')).toEqual(DEFAULT_PREVIEW_ZOOM)
    expect(parseStoredZoom('{"mode":"scale","scale":"2"}')).toEqual(DEFAULT_PREVIEW_ZOOM)
    expect(parseStoredZoom('{"mode":"zoomed"}')).toEqual(DEFAULT_PREVIEW_ZOOM)
    expect(parseStoredZoom('{"mode":"scale","scale":50}')).toEqual({ mode: 'scale', scale: PREVIEW_ZOOM_MAX })
  })

  it('survives a storage that throws (private window, blocked site data)', () => {
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      }
    }
    expect(loadPreviewZoom(throwing)).toEqual(DEFAULT_PREVIEW_ZOOM)
    expect(() => savePreviewZoom(throwing, { mode: 'overview' })).not.toThrow()
    expect(loadPreviewZoom(null)).toEqual(DEFAULT_PREVIEW_ZOOM)
  })

  it('uses one key for the whole browser', () => {
    const storage = memoryStorage()
    savePreviewZoom(storage, { mode: 'overview' })
    expect([...storage.data.keys()]).toEqual([PREVIEW_ZOOM_STORAGE_KEY])
  })
})

describe('keyboard shortcuts', () => {
  const key = (k: string, code: string, mods: { ctrl?: boolean, meta?: boolean, alt?: boolean } = {}) => ({
    key: k,
    code,
    ctrlKey: mods.ctrl ?? false,
    metaKey: mods.meta ?? false,
    altKey: mods.alt ?? false
  })

  it('maps Ctrl (Cmd on macOS) + = / - / 0', () => {
    expect(zoomShortcutAction(key('=', 'Equal', { ctrl: true }), false)).toBe('in')
    expect(zoomShortcutAction(key('+', 'Equal', { ctrl: true }), false)).toBe('in')
    expect(zoomShortcutAction(key('-', 'Minus', { ctrl: true }), false)).toBe('out')
    expect(zoomShortcutAction(key('0', 'Digit0', { ctrl: true }), false)).toBe('reset')
    expect(zoomShortcutAction(key('=', 'Equal', { meta: true }), true)).toBe('in')
    // German layout: the physical key still counts.
    expect(zoomShortcutAction(key('ß', 'Minus', { ctrl: true }), false)).toBe('out')
  })

  it('needs the platform modifier and ignores Alt and other keys', () => {
    expect(zoomShortcutAction(key('=', 'Equal'), false)).toBeNull()
    expect(zoomShortcutAction(key('=', 'Equal', { meta: true }), false)).toBeNull()
    expect(zoomShortcutAction(key('=', 'Equal', { ctrl: true }), true)).toBeNull()
    expect(zoomShortcutAction(key('-', 'Minus', { ctrl: true, alt: true }), false)).toBeNull()
    expect(zoomShortcutAction(key('b', 'KeyB', { ctrl: true }), false)).toBeNull()
  })
})

describe('labels + equality', () => {
  it('formats the factor as a locale percent', () => {
    expect(formatZoomPercent(0.87, 'en')).toBe('87%')
    expect(formatZoomPercent(1.25, 'de')).toMatch(/^125\s?%$/)
  })

  it('compares settings', () => {
    expect(sameZoomSetting({ mode: 'fit' }, { mode: 'fit' })).toBe(true)
    expect(sameZoomSetting({ mode: 'scale', scale: 1 }, { mode: 'scale', scale: 1.0001 })).toBe(true)
    expect(sameZoomSetting({ mode: 'scale', scale: 1 }, { mode: 'scale', scale: 1.25 })).toBe(false)
    expect(sameZoomSetting({ mode: 'fit' }, { mode: 'overview' })).toBe(false)
  })
})
