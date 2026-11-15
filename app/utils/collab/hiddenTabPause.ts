// Pure controller: let go of the sync connection while the editor's tab
// is hidden, take it up again when the tab is shown.
//
// Why: an open tab keeps its document loaded on the sync server for as
// long as it is open, and most open tabs are in the background. They
// filled the server's room cap with documents nobody looked at.
//
// States:
//   active  → the tab is visible.
//   hidden  → hidden, still connected; the user shows as away to the
//             others. After `hiddenTimeoutMs` the connection is released,
//             but only once the server has acknowledged every local
//             change (`canPause`): an unsent edit keeps it connected
//             until it is through.
//   paused  → disconnected. Showing the tab reconnects; the provider
//             resyncs by state vector, so nothing typed in between is lost.
//
// Timing: the default (4 min) sits below the 5 minutes after which
// Chrome throttles the timers of a hidden page to once a minute. The
// awareness renewal (every 15 s) then arrives too late, and the others
// would see the user leave and come back every minute. Leaving cleanly
// before that avoids the flicker. The timer is only a wake-up: every
// check compares the clock, so a late or throttled timer is harmless.
//
// The glue (`useDocument`) feeds visibility and connection changes in;
// every side effect goes through `deps`, which is what the tests stub.

export type HiddenTabState = 'active' | 'hidden' | 'paused'

export interface HiddenTabPauseDeps {
  isHidden: () => boolean
  /** Connected, synced and no local change waiting for the server. */
  canPause: () => boolean
  /** Release the connection. Returns false when it couldn't (not connected). */
  pause: () => boolean
  resume: () => void
  setAway: (away: boolean) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void
}

export interface HiddenTabPauseController {
  /** Visibility changed; also the initial call. */
  onVisibilityChange: () => void
  /** The connection or its pending changes changed: pause if it is time. */
  check: () => void
  state: () => HiddenTabState
  dispose: () => void
}

export function createHiddenTabPause(deps: HiddenTabPauseDeps, hiddenTimeoutMs: number): HiddenTabPauseController {
  const now = deps.now ?? (() => Date.now())
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? (t => clearTimeout(t))

  let state: HiddenTabState = 'active'
  let hiddenSince = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  function stopTimer() {
    if (timer) clearTimer(timer)
    timer = null
  }

  function check() {
    if (disposed || state !== 'hidden' || hiddenTimeoutMs <= 0) return
    const remaining = hiddenSince + hiddenTimeoutMs - now()
    if (remaining > 0) {
      if (!timer) {
        timer = setTimer(() => {
          timer = null
          check()
        }, remaining)
      }
      return
    }
    // Waits for the next `check()` from a connection change otherwise.
    if (!deps.canPause()) return
    if (deps.pause()) state = 'paused'
  }

  function onVisibilityChange() {
    if (disposed) return
    if (deps.isHidden()) {
      if (state !== 'active') return
      state = 'hidden'
      hiddenSince = now()
      deps.setAway(true)
      check()
      return
    }
    if (state === 'active') return
    stopTimer()
    const wasPaused = state === 'paused'
    state = 'active'
    deps.setAway(false)
    if (wasPaused) deps.resume()
  }

  return {
    onVisibilityChange,
    check,
    state: () => state,
    dispose() {
      disposed = true
      stopTimer()
    }
  }
}
