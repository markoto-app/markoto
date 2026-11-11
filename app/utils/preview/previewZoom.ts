/**
 * Live-preview zoom: the user's setting, the fixed steps, zoom in / out,
 * the keyboard shortcut matcher and the per-browser persistence. Pure
 * (no Nuxt / Vue), so it is unit-tested directly; the reactive state
 * lives in `usePreviewZoom`, the layout itself inside the preview iframe
 * (`previewZoomFrame.ts`).
 *
 *   fit       one page fills the pane width (never enlarged past 100 %) —
 *             the default and the behaviour before zoom existed;
 *   scale     a fixed factor (toolbar steps, Ctrl/Cmd +/-, pinch);
 *   overview  "All pages": the pages wrap side by side in a grid.
 *
 * Zoom is presentation only: it never re-paginates, and the print / PDF
 * paths and the server renderer never see it.
 */

export type PreviewZoomSetting
  = | { mode: 'fit' }
    | { mode: 'scale', scale: number }
    | { mode: 'overview' }

/** Fixed steps offered in the menu and walked by zoom in / out. */
export const PREVIEW_ZOOM_STEPS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2]

/** Range of a free zoom factor (pinch / Ctrl+wheel). */
export const PREVIEW_ZOOM_MIN = 0.3
export const PREVIEW_ZOOM_MAX = 3

/**
 * A pinch / Ctrl+wheel that ends this far below the minimum zoom pulls
 * back into the overview instead of stopping at the minimum.
 */
const PREVIEW_OVERVIEW_GESTURE_THRESHOLD = PREVIEW_ZOOM_MIN * 0.85

/** localStorage key — one setting per browser, not per document. */
export const PREVIEW_ZOOM_STORAGE_KEY = 'markoto:preview-zoom'

export const DEFAULT_PREVIEW_ZOOM: PreviewZoomSetting = { mode: 'fit' }

const EPSILON = 0.001
/**
 * A step must differ from what is shown by at least 5 % to count as the
 * next one — fit width at 74 % zooms in to 100 %, not to a barely
 * visible 75 %.
 */
const STEP_MARGIN = 1.05

export function clampZoom(scale: number): number {
  if (!Number.isFinite(scale)) return 1
  return Math.min(PREVIEW_ZOOM_MAX, Math.max(PREVIEW_ZOOM_MIN, Math.round(scale * 100) / 100))
}

/**
 * One step in (see STEP_MARGIN). `effective` is the scale the preview currently shows (in
 * fit mode that depends on the pane width, so the iframe reports it).
 * From the overview, zooming in returns to fit width.
 */
export function zoomInFrom(setting: PreviewZoomSetting, effective: number | null): PreviewZoomSetting {
  if (setting.mode === 'overview') return { mode: 'fit' }
  const current = currentScale(setting, effective)
  const next = PREVIEW_ZOOM_STEPS.find(s => s > current * STEP_MARGIN)
  return { mode: 'scale', scale: next ?? Math.max(current, PREVIEW_ZOOM_STEPS.at(-1) ?? 1) }
}

/** One step out. Below the smallest step comes the overview. */
export function zoomOutFrom(setting: PreviewZoomSetting, effective: number | null): PreviewZoomSetting {
  if (setting.mode === 'overview') return setting
  const current = currentScale(setting, effective)
  const lower = PREVIEW_ZOOM_STEPS.filter(s => s < current / STEP_MARGIN)
  const prev = lower.at(-1)
  return prev === undefined ? { mode: 'overview' } : { mode: 'scale', scale: prev }
}

function currentScale(setting: PreviewZoomSetting, effective: number | null): number {
  if (setting.mode === 'scale') return setting.scale
  return effective !== null && Number.isFinite(effective) && effective > 0 ? effective : 1
}

/** Setting after a pinch / Ctrl+wheel gesture ended at `scale`. */
export function settingFromGesture(scale: number): PreviewZoomSetting {
  if (scale < PREVIEW_OVERVIEW_GESTURE_THRESHOLD) return { mode: 'overview' }
  return { mode: 'scale', scale: clampZoom(scale) }
}

export function sameZoomSetting(a: PreviewZoomSetting, b: PreviewZoomSetting): boolean {
  if (a.mode !== b.mode) return false
  return a.mode !== 'scale' || b.mode !== 'scale' || Math.abs(a.scale - b.scale) < EPSILON
}

/** Stored form → setting; anything unexpected falls back to the default. */
export function parseStoredZoom(raw: string | null): PreviewZoomSetting {
  if (!raw) return DEFAULT_PREVIEW_ZOOM
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return DEFAULT_PREVIEW_ZOOM
  }
  if (typeof data !== 'object' || data === null) return DEFAULT_PREVIEW_ZOOM
  const v = data as Record<string, unknown>
  if (v.mode === 'fit') return { mode: 'fit' }
  if (v.mode === 'overview') return { mode: 'overview' }
  if (v.mode === 'scale' && typeof v.scale === 'number' && Number.isFinite(v.scale)) {
    return { mode: 'scale', scale: clampZoom(v.scale) }
  }
  return DEFAULT_PREVIEW_ZOOM
}

function serializeZoom(setting: PreviewZoomSetting): string {
  return JSON.stringify(setting)
}

export function loadPreviewZoom(storage: Pick<Storage, 'getItem'> | null | undefined): PreviewZoomSetting {
  try {
    return parseStoredZoom(storage?.getItem(PREVIEW_ZOOM_STORAGE_KEY) ?? null)
  } catch {
    // Storage blocked (private window, sandbox, cleared site data).
    return DEFAULT_PREVIEW_ZOOM
  }
}

export function savePreviewZoom(storage: Pick<Storage, 'setItem'> | null | undefined, setting: PreviewZoomSetting): void {
  try {
    storage?.setItem(PREVIEW_ZOOM_STORAGE_KEY, serializeZoom(setting))
  } catch {
    // Best effort: the choice simply isn't remembered.
  }
}

export type ZoomShortcutAction = 'in' | 'out' | 'reset'

/**
 * Ctrl/Cmd + `=` / `+` → in, `-` → out, `0` → reset (fit width). Matches
 * on `key` and on the physical key (`code`) so non-US layouts work too.
 * Alt is never part of it (Alt+Cmd combos belong to the OS / browser).
 * The same rule runs inside the preview iframe (`previewZoomFrame.ts`).
 */
export function zoomShortcutAction(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey'>,
  isMac: boolean
): ZoomShortcutAction | null {
  const mod = isMac ? e.metaKey : e.ctrlKey
  if (!mod || e.altKey) return null
  if (e.key === '=' || e.key === '+' || e.code === 'Equal' || e.code === 'NumpadAdd') return 'in'
  if (e.key === '-' || e.key === '_' || e.code === 'Minus' || e.code === 'NumpadSubtract') return 'out'
  if (e.key === '0' || e.code === 'Digit0' || e.code === 'Numpad0') return 'reset'
  return null
}

/** Cmd (macOS / iOS) or Ctrl as the shortcut modifier — same test as the iframe's. */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const uad: unknown = Reflect.get(navigator, 'userAgentData')
  const platform = typeof uad === 'object' && uad !== null ? Reflect.get(uad, 'platform') : undefined
  if (typeof platform === 'string' && platform) return /mac/i.test(platform)
  return /Mac|iPhone|iPad/.test(navigator.platform)
}

/** "87 %"-style label for a scale (locale-formatted percent). */
export function formatZoomPercent(scale: number, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(scale)
  } catch {
    return `${Math.round(scale * 100)}%`
  }
}
