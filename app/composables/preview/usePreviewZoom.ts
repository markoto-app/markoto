import {
  DEFAULT_PREVIEW_ZOOM,
  PREVIEW_ZOOM_STEPS,
  formatZoomPercent,
  loadPreviewZoom,
  sameZoomSetting,
  savePreviewZoom,
  settingFromGesture,
  zoomInFrom,
  zoomOutFrom,
  type PreviewZoomSetting
} from '~/utils/preview/previewZoom'
import type { DropdownMenuItem } from '@nuxt/ui'
import type { FrameZoomMode } from '~/utils/preview/previewZoomFrame'

/** What the preview iframe should apply next (consumed by `usePagedPreview`). */
export interface PreviewZoomCommand {
  setting: PreviewZoomSetting
  animate: boolean
  /** 1-based page to scroll to the top, 0 = keep the reading position. */
  page: number
  /** Increments per command so a repeated identical command still reaches the frame. */
  seq: number
}

interface ZoomShared {
  setting: PreviewZoomSetting
  /** Effective factor the frame reports (fit width depends on the pane). */
  effective: number | null
  fitScale: number | null
  command: PreviewZoomCommand
  loaded: boolean
}

/**
 * Preview zoom state, shared by the preview pane (desktop control +
 * iframe), the mobile view-mode bar and the View menu. Remembered per
 * browser in localStorage (`previewZoom.ts`), never per document.
 */
export function usePreviewZoom() {
  const state = useState<ZoomShared>('preview-zoom', () => ({
    setting: DEFAULT_PREVIEW_ZOOM,
    effective: null,
    fitScale: null,
    command: { setting: DEFAULT_PREVIEW_ZOOM, animate: false, page: 0, seq: 0 },
    loaded: false
  }))

  function storage(): Storage | null {
    try {
      return import.meta.client ? globalThis.localStorage : null
    } catch {
      return null
    }
  }

  function send(setting: PreviewZoomSetting, animate: boolean, page = 0): void {
    state.value.command = { setting, animate, page, seq: state.value.command.seq + 1 }
  }

  /** Change the setting. `send: false` when the frame already shows it (gestures). */
  function set(setting: PreviewZoomSetting, opts: { animate?: boolean, page?: number, send?: boolean } = {}): void {
    const changed = !sameZoomSetting(state.value.setting, setting)
    state.value.setting = setting
    if (changed) savePreviewZoom(storage(), setting)
    if (opts.send !== false) send(setting, opts.animate ?? true, opts.page ?? 0)
  }

  /** Read the remembered choice once per page load (client only, after hydration). */
  function load(): void {
    if (state.value.loaded || !import.meta.client) return
    state.value.loaded = true
    const stored = loadPreviewZoom(storage())
    if (!sameZoomSetting(stored, state.value.setting)) {
      state.value.setting = stored
      send(stored, false)
    }
  }

  const setting = computed(() => state.value.setting)
  const mode = computed<FrameZoomMode>(() => state.value.setting.mode)
  const effective = computed(() => state.value.effective)
  const fitScale = computed(() => state.value.fitScale)
  const isOverview = computed(() => state.value.setting.mode === 'overview')

  return {
    setting,
    mode,
    effective,
    fitScale,
    isOverview,
    command: computed(() => state.value.command),
    load,
    set,
    fit: () => set({ mode: 'fit' }),
    overview: () => set({ mode: 'overview' }),
    toggleOverview: () => set(isOverview.value ? { mode: 'fit' } : { mode: 'overview' }),
    scale: (scale: number) => set({ mode: 'scale', scale }),
    zoomIn: () => set(zoomInFrom(state.value.setting, state.value.effective)),
    zoomOut: () => set(zoomOutFrom(state.value.setting, state.value.effective)),
    /** Overview page clicked: back to fit width, scrolled to that page. */
    openPage: (page: number) => set({ mode: 'fit' }, { page }),
    /** A pinch / Ctrl+wheel in the frame ended at `scale`. */
    gestureEnded: (scale: number) => {
      const next = settingFromGesture(scale)
      set(next, { send: next.mode === 'overview' })
    },
    /** The frame reports what it applied. */
    reportApplied: (scale: number, fitScale: number) => {
      state.value.effective = scale
      state.value.fitScale = fitScale
    }
  }
}

/**
 * Menu items for the zoom dropdown (preview pane control, mobile bar,
 * View menu): fit width, all pages, the fixed steps — plus zoom in / out
 * where there are no separate buttons for them.
 */
export function usePreviewZoomMenu(opts: { withStepItems?: boolean } = {}) {
  const zoom = usePreviewZoom()
  const { t, locale } = useI18n()

  const label = computed(() => {
    if (zoom.isOverview.value) return t('previewZoom.allPages')
    const s = zoom.setting.value
    // Fit width shows the last reported fit factor: right away, not only
    // once the frame confirms the switch.
    const scale = s.mode === 'scale' ? s.scale : (zoom.fitScale.value ?? zoom.effective.value)
    return scale === null ? t('previewZoom.fitWidth') : formatZoomPercent(scale, locale.value)
  })

  const items = computed<DropdownMenuItem[][]>(() => {
    const s = zoom.setting.value
    const groups: DropdownMenuItem[][] = []
    if (opts.withStepItems) {
      groups.push([
        { label: t('previewZoom.zoomIn'), icon: 'i-lucide-zoom-in', kbds: ['meta', '='], onSelect: () => zoom.zoomIn() },
        { label: t('previewZoom.zoomOut'), icon: 'i-lucide-zoom-out', kbds: ['meta', '-'], onSelect: () => zoom.zoomOut() }
      ])
    }
    groups.push([
      {
        label: t('previewZoom.fitWidth'),
        icon: 'i-lucide-move-horizontal',
        type: 'checkbox',
        checked: s.mode === 'fit',
        kbds: ['meta', '0'],
        onSelect: () => zoom.fit()
      },
      {
        label: t('previewZoom.allPages'),
        icon: 'i-lucide-layout-grid',
        type: 'checkbox',
        checked: s.mode === 'overview',
        onSelect: () => zoom.overview()
      }
    ], PREVIEW_ZOOM_STEPS.map(step => ({
      label: formatZoomPercent(step, locale.value),
      type: 'checkbox',
      checked: s.mode === 'scale' && Math.abs(s.scale - step) < 0.001,
      onSelect: () => zoom.scale(step)
    })))
    return groups
  })

  return { zoom, label, items }
}
