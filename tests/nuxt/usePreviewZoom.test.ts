import { beforeEach, describe, expect, it } from 'vitest'
import { usePreviewZoom } from '~/composables/usePreviewZoom'
import { PREVIEW_ZOOM_STORAGE_KEY } from '~/utils/previewZoom'

// Shared preview-zoom state (desktop pill, mobile bar, View menu and the
// iframe all go through it). Remembered per browser in localStorage.

describe('usePreviewZoom', () => {
  beforeEach(() => {
    localStorage.removeItem(PREVIEW_ZOOM_STORAGE_KEY)
    const zoom = usePreviewZoom()
    zoom.set({ mode: 'fit' }, { send: false })
    zoom.reportApplied(0.8, 0.8)
  })

  it('starts at fit width and sends every change to the frame, animated', () => {
    const zoom = usePreviewZoom()
    expect(zoom.setting.value).toEqual({ mode: 'fit' })
    const seq = zoom.command.value.seq
    zoom.overview()
    expect(zoom.command.value).toMatchObject({ setting: { mode: 'overview' }, animate: true, page: 0, seq: seq + 1 })
    expect(zoom.isOverview.value).toBe(true)
  })

  it('remembers the choice in localStorage (one key for the browser)', () => {
    const zoom = usePreviewZoom()
    zoom.scale(1.5)
    expect(JSON.parse(localStorage.getItem(PREVIEW_ZOOM_STORAGE_KEY) ?? 'null')).toEqual({ mode: 'scale', scale: 1.5 })
  })

  it('steps from what the frame shows', () => {
    const zoom = usePreviewZoom()
    zoom.zoomIn()
    expect(zoom.setting.value).toEqual({ mode: 'scale', scale: 1 })
    zoom.zoomOut()
    zoom.zoomOut()
    expect(zoom.setting.value).toEqual({ mode: 'scale', scale: 0.5 })
    zoom.zoomOut()
    expect(zoom.setting.value).toEqual({ mode: 'overview' })
    zoom.zoomIn()
    expect(zoom.setting.value).toEqual({ mode: 'fit' })
  })

  it('opens a clicked overview page at fit width, scrolled to it', () => {
    const zoom = usePreviewZoom()
    zoom.overview()
    zoom.openPage(5)
    expect(zoom.command.value).toMatchObject({ setting: { mode: 'fit' }, animate: true, page: 5 })
  })

  it('stores a gesture without echoing it back, unless it ends in the overview', () => {
    const zoom = usePreviewZoom()
    const seq = zoom.command.value.seq
    zoom.gestureEnded(1.37)
    expect(zoom.setting.value).toEqual({ mode: 'scale', scale: 1.37 })
    expect(zoom.command.value.seq).toBe(seq)
    zoom.gestureEnded(0.1)
    expect(zoom.setting.value).toEqual({ mode: 'overview' })
    expect(zoom.command.value.seq).toBe(seq + 1)
  })
})
