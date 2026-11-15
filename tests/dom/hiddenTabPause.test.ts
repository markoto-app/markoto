import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHiddenTabPause, type HiddenTabPauseDeps } from '~/utils/collab/hiddenTabPause'

// State machine behind "release the sync connection while the tab is
// hidden": hidden → away at once, disconnect after the timeout once no
// local change is pending, reconnect when shown.

const TIMEOUT = 240_000

function harness(opts: { canPause?: boolean, pauseResult?: boolean, timeout?: number } = {}) {
  let hidden = false
  let canPause = opts.canPause ?? true
  const calls: string[] = []
  const deps: HiddenTabPauseDeps = {
    isHidden: () => hidden,
    canPause: () => canPause,
    pause: () => {
      calls.push('pause')
      return opts.pauseResult ?? true
    },
    resume: () => calls.push('resume'),
    setAway: away => calls.push(away ? 'away' : 'back')
  }
  const controller = createHiddenTabPause(deps, opts.timeout ?? TIMEOUT)
  return {
    controller,
    calls,
    hide() {
      hidden = true
      controller.onVisibilityChange()
    },
    show() {
      hidden = false
      controller.onVisibilityChange()
    },
    setCanPause(v: boolean) {
      canPause = v
    }
  }
}

describe('hidden tab pause', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does nothing while the tab stays visible', () => {
    const h = harness()
    h.controller.onVisibilityChange()
    vi.advanceTimersByTime(TIMEOUT * 2)
    expect(h.calls).toEqual([])
    expect(h.controller.state()).toBe('active')
  })

  it('marks the user away at once and disconnects after the timeout', () => {
    const h = harness()
    h.hide()
    expect(h.calls).toEqual(['away'])
    expect(h.controller.state()).toBe('hidden')
    vi.advanceTimersByTime(TIMEOUT - 1)
    expect(h.calls).toEqual(['away'])
    vi.advanceTimersByTime(1)
    expect(h.calls).toEqual(['away', 'pause'])
    expect(h.controller.state()).toBe('paused')
  })

  it('reconnects and clears away when the tab is shown again', () => {
    const h = harness()
    h.hide()
    vi.advanceTimersByTime(TIMEOUT)
    h.show()
    expect(h.calls).toEqual(['away', 'pause', 'back', 'resume'])
    expect(h.controller.state()).toBe('active')
  })

  it('a short hide only toggles away and never disconnects', () => {
    const h = harness()
    h.hide()
    vi.advanceTimersByTime(60_000)
    h.show()
    vi.advanceTimersByTime(TIMEOUT * 2)
    expect(h.calls).toEqual(['away', 'back'])
  })

  it('waits for pending local changes before it disconnects', () => {
    const h = harness({ canPause: false })
    h.hide()
    vi.advanceTimersByTime(TIMEOUT * 3)
    expect(h.calls).toEqual(['away'])
    expect(h.controller.state()).toBe('hidden')

    // The server acknowledged the last change.
    h.setCanPause(true)
    h.controller.check()
    expect(h.calls).toEqual(['away', 'pause'])
  })

  it('does not count a check before the timeout as a reason to pause', () => {
    const h = harness()
    h.hide()
    vi.advanceTimersByTime(1000)
    h.controller.check()
    expect(h.calls).toEqual(['away'])
  })

  it('pauses on time even when the timer fires late (throttled background tab)', () => {
    const h = harness()
    h.hide()
    // A throttled timer: the clock moved on, the callback has not run yet.
    vi.setSystemTime(Date.now() + TIMEOUT + 60_000)
    h.controller.check()
    expect(h.calls).toEqual(['away', 'pause'])
  })

  it('stays hidden when the provider refuses to pause, and retries on the next check', () => {
    let accept = false
    const calls: string[] = []
    let hidden = true
    const controller = createHiddenTabPause({
      isHidden: () => hidden,
      canPause: () => true,
      pause: () => {
        calls.push('pause')
        return accept
      },
      resume: () => calls.push('resume'),
      setAway: () => {}
    }, TIMEOUT)
    controller.onVisibilityChange()
    vi.advanceTimersByTime(TIMEOUT)
    expect(controller.state()).toBe('hidden')
    accept = true
    controller.check()
    expect(controller.state()).toBe('paused')
    hidden = false
    controller.onVisibilityChange()
    expect(calls).toEqual(['pause', 'pause', 'resume'])
  })

  it('with a timeout of 0 only marks away and keeps the connection', () => {
    const h = harness({ timeout: 0 })
    h.hide()
    vi.advanceTimersByTime(TIMEOUT * 10)
    h.show()
    expect(h.calls).toEqual(['away', 'back'])
  })

  it('stops after dispose', () => {
    const h = harness()
    h.hide()
    h.controller.dispose()
    vi.advanceTimersByTime(TIMEOUT * 2)
    h.show()
    expect(h.calls).toEqual(['away'])
  })
})
