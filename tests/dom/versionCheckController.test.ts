import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import {
  createVersionCheckController,
  type VersionCheckPromptHandlers
} from '../../app/utils/platform/versionCheckController'

// Pure controller test — no Nuxt boot, no `$fetch`, no toast renderer.
// We stub the three dependencies the controller needs (fetch, reload,
// showPrompt) and use Vitest's fake timers to drive the grace-period +
// snooze + visibility-throttle timing assertions deterministically.
//
// Grace and snooze defaults exercised below match what
// `app/plugins/version-check.client.ts` ships in production: 30s grace,
// 5min snooze, 60s visibility throttle, 5min poll interval.

describe('versionCheckController', () => {
  let fetchBuildId: Mock<() => Promise<string | null>>
  let reload: Mock<() => void>
  let showPrompt: Mock<(handlers: VersionCheckPromptHandlers) => void>
  let lastHandlers: VersionCheckPromptHandlers | null

  beforeEach(() => {
    vi.useFakeTimers()
    fetchBuildId = vi.fn<() => Promise<string | null>>()
    reload = vi.fn<() => void>()
    lastHandlers = null
    showPrompt = vi.fn((h: VersionCheckPromptHandlers) => {
      lastHandlers = h
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function makeController(opts?: { graceMs?: number, snoozeMs?: number, visibilityThrottleMs?: number, pollIntervalMs?: number }) {
    return createVersionCheckController(
      {
        fetchBuildId: () => fetchBuildId(),
        reload: () => reload(),
        showPrompt: h => showPrompt(h)
      },
      opts
    )
  }

  // Baseline + mismatch detection

  it('first poll captures baseline; no prompt while build id is stable', async () => {
    fetchBuildId.mockResolvedValueOnce('build-A').mockResolvedValueOnce('build-A')
    const ctl = makeController()
    await ctl.poll()
    await ctl.poll()
    expect(showPrompt).not.toHaveBeenCalled()
    ctl.dispose()
  })

  it('shows prompt the first time the build id differs from baseline', async () => {
    fetchBuildId.mockResolvedValueOnce('build-A').mockResolvedValueOnce('build-B')
    const ctl = makeController()
    await ctl.poll() // sets baseline
    await ctl.poll() // mismatch → prompt
    expect(showPrompt).toHaveBeenCalledTimes(1)
    ctl.dispose()
  })

  it('only shows the prompt once even if poll runs again with a third id', async () => {
    fetchBuildId
      .mockResolvedValueOnce('build-A')
      .mockResolvedValueOnce('build-B')
      .mockResolvedValueOnce('build-C')
    const ctl = makeController()
    await ctl.poll()
    await ctl.poll()
    await ctl.poll()
    expect(showPrompt).toHaveBeenCalledTimes(1)
    ctl.dispose()
  })

  it('swallows fetch errors without setting a baseline', async () => {
    fetchBuildId.mockRejectedValueOnce(new Error('net down'))
    fetchBuildId.mockResolvedValueOnce('build-A')
    const ctl = makeController()
    await ctl.poll() // throws, no baseline set
    await ctl.poll() // baseline now build-A
    expect(showPrompt).not.toHaveBeenCalled()
    ctl.dispose()
  })

  // Auto-reload after 30s grace

  it('auto-reloads after the 30s grace window with no user interaction', async () => {
    fetchBuildId.mockResolvedValueOnce('A').mockResolvedValueOnce('B')
    const ctl = makeController()
    await ctl.poll()
    await ctl.poll()

    expect(reload).not.toHaveBeenCalled()
    // Just under the grace window — still no reload.
    vi.advanceTimersByTime(29_999)
    expect(reload).not.toHaveBeenCalled()
    // Tick past 30s.
    vi.advanceTimersByTime(2)
    expect(reload).toHaveBeenCalledTimes(1)
    ctl.dispose()
  })

  // Reload-now button

  it('"Reload now" reloads immediately and cancels the auto-reload timer', async () => {
    fetchBuildId.mockResolvedValueOnce('A').mockResolvedValueOnce('B')
    const ctl = makeController()
    await ctl.poll()
    await ctl.poll()

    lastHandlers!.onReloadNow()
    expect(reload).toHaveBeenCalledTimes(1)

    // Advancing past 30s must NOT fire a second reload (the timer was
    // cleared). A double-reload would be doubly-broken: it would interrupt
    // the new page load.
    vi.advanceTimersByTime(60_000)
    expect(reload).toHaveBeenCalledTimes(1)
    ctl.dispose()
  })

  // Snooze

  it('"Snooze" defers the auto-reload by 5 minutes from the click', async () => {
    fetchBuildId.mockResolvedValueOnce('A').mockResolvedValueOnce('B')
    const ctl = makeController()
    await ctl.poll()
    await ctl.poll()

    // Let 10s of the original 30s grace pass, then snooze.
    vi.advanceTimersByTime(10_000)
    lastHandlers!.onSnooze()

    // Past the original 30s window, no reload — the snooze cleared it.
    vi.advanceTimersByTime(30_000)
    expect(reload).not.toHaveBeenCalled()

    // Just under 5 min more — still no reload.
    vi.advanceTimersByTime(5 * 60 * 1000 - 31_000)
    expect(reload).not.toHaveBeenCalled()

    // Cross the 5-minute mark — reload fires.
    vi.advanceTimersByTime(2_000)
    expect(reload).toHaveBeenCalledTimes(1)
    ctl.dispose()
  })

  it('Snooze can be clicked multiple times — each click resets the timer', async () => {
    fetchBuildId.mockResolvedValueOnce('A').mockResolvedValueOnce('B')
    const ctl = makeController()
    await ctl.poll()
    await ctl.poll()

    lastHandlers!.onSnooze()
    vi.advanceTimersByTime(4 * 60 * 1000) // 4 min into snooze
    lastHandlers!.onSnooze() // reset
    vi.advanceTimersByTime(4 * 60 * 1000) // 4 more min — only 4/5 into the new window
    expect(reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_001)
    expect(reload).toHaveBeenCalledTimes(1)
    ctl.dispose()
  })

  // visibilitychange-driven poll

  it('onVisible polls if past the throttle window', async () => {
    fetchBuildId.mockResolvedValue('A')
    let nowMs = 1_000_000
    const ctl = createVersionCheckController(
      {
        fetchBuildId: () => fetchBuildId(),
        reload: () => reload(),
        showPrompt: h => showPrompt(h),
        now: () => nowMs
      }
    )
    await ctl.poll() // sets lastPolledAt = 1_000_000
    expect(fetchBuildId).toHaveBeenCalledTimes(1)

    // 30s later — under the 60s throttle, no second poll.
    nowMs += 30_000
    ctl.onVisible()
    expect(fetchBuildId).toHaveBeenCalledTimes(1)

    // Past 60s — onVisible polls.
    nowMs += 31_000
    ctl.onVisible()
    // The poll is async; flush microtasks.
    await Promise.resolve()
    expect(fetchBuildId).toHaveBeenCalledTimes(2)
    ctl.dispose()
  })

  it('onVisible is a no-op once the prompt is shown', async () => {
    fetchBuildId.mockResolvedValueOnce('A').mockResolvedValueOnce('B')
    let nowMs = 0
    const ctl = createVersionCheckController(
      {
        fetchBuildId: () => fetchBuildId(),
        reload: () => reload(),
        showPrompt: h => showPrompt(h),
        now: () => nowMs
      }
    )
    await ctl.poll()
    nowMs += 5 * 60 * 1000
    await ctl.poll() // mismatch → prompt
    expect(showPrompt).toHaveBeenCalledTimes(1)

    // Even though we're well past the visibility throttle, no further poll.
    nowMs += 24 * 60 * 60 * 1000
    ctl.onVisible()
    expect(fetchBuildId).toHaveBeenCalledTimes(2)
    ctl.dispose()
  })

  // Periodic polling via setInterval

  it('polls again on the periodic interval', async () => {
    fetchBuildId.mockResolvedValue('A')
    const ctl = makeController({ pollIntervalMs: 1000 })
    await ctl.poll()
    expect(fetchBuildId).toHaveBeenCalledTimes(1)

    // Advance through three intervals; each should kick a poll.
    await vi.advanceTimersByTimeAsync(3_500)
    // First poll + 3 from the interval ticks at 1s, 2s, 3s.
    expect(fetchBuildId).toHaveBeenCalledTimes(4)
    ctl.dispose()
  })

  // dispose

  it('dispose clears the poll interval and any pending reload timer', async () => {
    fetchBuildId.mockResolvedValueOnce('A').mockResolvedValueOnce('B')
    const ctl = makeController({ pollIntervalMs: 1000 })
    await ctl.poll()
    await ctl.poll() // mismatch → grace timer started
    ctl.dispose()

    vi.advanceTimersByTime(60_000)
    expect(reload).not.toHaveBeenCalled() // grace timer cleared
    // No further fetch from the disposed interval either (still 2 calls).
    expect(fetchBuildId).toHaveBeenCalledTimes(2)
  })
})
