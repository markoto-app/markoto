import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EARLY_CLICK_QUEUE,
  EARLY_CLICK_SCRIPT,
  HYDRATED_ATTR,
  markHydratedAndReplay
} from '../../app/utils/platform/earlyClicks'

// The pre-hydration click queue (app/utils/platform/earlyClicks.ts): the
// inline head script remembers clicks on `[data-early-click]` buttons, the
// plugin replays them once the handlers exist.

function runHeadScript(): void {
  // The exact string the server puts in the page head.
  new Function(EARLY_CLICK_SCRIPT)()
}

describe('early clicks', () => {
  let listeners: Array<() => void> = []
  const addEventListener = document.addEventListener.bind(document)

  beforeEach(() => {
    document.body.innerHTML = `
      <button id="start" data-early-click><span id="label">Start writing</span></button>
      <button id="other">Other</button>`
    // Track the script's document listener so each test starts clean.
    vi.spyOn(document, 'addEventListener').mockImplementation((type, fn, opts) => {
      addEventListener(type, fn, opts)
      listeners.push(() => document.removeEventListener(type, fn, opts))
    })
    runHeadScript()
  })

  afterEach(() => {
    for (const remove of listeners) remove()
    listeners = []
    vi.restoreAllMocks()
    document.documentElement.removeAttribute(HYDRATED_ATTR)
    Reflect.deleteProperty(window, EARLY_CLICK_QUEUE)
  })

  it('replays a click made before hydration once the handler is attached', () => {
    const start = document.getElementById('start')!
    // Before hydration: the server-rendered button has no handler yet.
    document.getElementById('label')!.click()
    start.click()

    // Hydration attaches the handler, then the plugin replays.
    const handler = vi.fn()
    start.addEventListener('click', handler)
    expect(markHydratedAndReplay(document, window)).toBe(1)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(document.documentElement.hasAttribute(HYDRATED_ATTR)).toBe(true)
  })

  it('ignores buttons without the attribute', () => {
    const other = document.getElementById('other')!
    other.click()
    const handler = vi.fn()
    other.addEventListener('click', handler)
    expect(markHydratedAndReplay(document, window)).toBe(0)
    expect(handler).not.toHaveBeenCalled()
  })

  it('stops queueing once the page has hydrated', () => {
    markHydratedAndReplay(document, window)
    const start = document.getElementById('start')!
    const handler = vi.fn()
    start.addEventListener('click', handler)
    start.click()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(Reflect.get(window, EARLY_CLICK_QUEUE)).toEqual([])
  })

  it('skips a queued button that hydration replaced', () => {
    document.getElementById('start')!.click()
    document.body.innerHTML = '<button id="start" data-early-click>Start writing</button>'
    expect(markHydratedAndReplay(document, window)).toBe(0)
  })
})
