// @vitest-environment nuxt
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises, type VueWrapper } from '@vue/test-utils'
import { LandingProductTour } from '#components'
import { DEMO_VIDEO } from '~~/shared/media/demoVideo'

// The product page's hero picture plays the demo video in a lightbox. The
// video and its captions load only after the click; the dialog closes on
// Esc and its close button, pauses the video and gives focus back to the
// play button.

const overlay = () => document.body.querySelector<HTMLElement>('[data-testid="demo-video-overlay"]')
const overlayVideo = () => document.body.querySelector<HTMLVideoElement>('[data-testid="demo-video-overlay-video"]')

/** Every element in the page that would fetch the demo video or its captions. */
function demoMediaInDom(): Element[] {
  return [...document.querySelectorAll('[src]')].filter((el) => {
    const src = el.getAttribute('src')
    return src === DEMO_VIDEO.src || src === DEMO_VIDEO.captions
  })
}

let play: ReturnType<typeof vi.spyOn>
let pause: ReturnType<typeof vi.spyOn>
let wrapper: VueWrapper | null = null

beforeEach(() => {
  play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.restoreAllMocks()
})

async function mountTour(): Promise<VueWrapper> {
  wrapper = await mountSuspended(LandingProductTour, { attachTo: document.body })
  return wrapper
}

async function openFrom(testid: string): Promise<HTMLElement> {
  const trigger = document.querySelector<HTMLElement>(`[data-testid="${testid}"]`)
  expect(trigger).not.toBeNull()
  trigger!.focus()
  trigger!.click()
  await vi.waitFor(() => expect(overlayVideo()).not.toBeNull())
  return trigger!
}

describe('product page: demo video from the hero picture', () => {
  it('shows a labelled play button on the hero picture and loads no video before the click', async () => {
    await mountTour()
    for (const id of ['tour-demo-play', 'tour-demo-play-stage']) {
      const button = document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)
      expect(button?.tagName).toBe('BUTTON')
      expect(button?.getAttribute('type')).toBe('button')
      expect(button?.getAttribute('aria-haspopup')).toBe('dialog')
      expect(button?.textContent?.trim()).toBe('Watch the 2-minute demo')
      // Not inside anything hidden from assistive tech.
      expect(button?.closest('[aria-hidden="true"]')).toBeNull()
    }
    expect(demoMediaInDom()).toEqual([])
    expect(overlay()).toBeNull()
  })

  it('opens the video on click, playing with sound, captions available but off', async () => {
    await mountTour()
    await openFrom('tour-demo-play')
    const video = overlayVideo()!
    expect(video.getAttribute('poster')).toBe(DEMO_VIDEO.poster)
    expect(video.hasAttribute('controls')).toBe(true)
    expect(video.hasAttribute('playsinline')).toBe(true)
    expect(video.hasAttribute('muted')).toBe(false)
    expect(video.querySelector('source')?.getAttribute('src')).toBe(DEMO_VIDEO.src)
    const track = video.querySelector('track')!
    expect(track.getAttribute('kind')).toBe('captions')
    expect(track.getAttribute('srclang')).toBe('en')
    expect(track.getAttribute('src')).toBe(DEMO_VIDEO.captions)
    // The cards in the video show the same text: captions stay off.
    expect(track.hasAttribute('default')).toBe(false)
    await vi.waitFor(() => expect(play).toHaveBeenCalled())
    const dialog = video.closest('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.contains(document.activeElement)).toBe(true)
  })

  it('closes on Escape, pauses the video and returns focus to the play button', async () => {
    await mountTour()
    const trigger = await openFrom('tour-demo-play')
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await vi.waitFor(() => expect(overlay()).toBeNull())
    expect(pause).toHaveBeenCalled()
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('closes with its close button and opens again', async () => {
    await mountTour()
    const trigger = await openFrom('tour-demo-play-stage')
    document.body.querySelector<HTMLButtonElement>('[data-testid="demo-video-overlay-close"]')!.click()
    await vi.waitFor(() => expect(overlay()).toBeNull())
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger))
    await openFrom('tour-demo-play-stage')
    await flushPromises()
    expect(overlay()).not.toBeNull()
  })

  it('shows the label in the page language, captions off there too', async () => {
    const i18n = useNuxtApp().$i18n
    await i18n.setLocale('de')
    try {
      await mountTour()
      expect(document.querySelector('[data-testid="tour-demo-play"]')?.textContent?.trim()).toBe('2-Minuten-Demo anschauen')
      await openFrom('tour-demo-play')
      expect(overlayVideo()!.querySelector('track')?.hasAttribute('default')).toBe(false)
    } finally {
      await i18n.setLocale('en')
    }
  })
})
