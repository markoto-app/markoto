// Pure controller for the version-check auto-reload state machine.
// Extracted from `app/plugins/version-check.client.ts` so the polling +
// grace-period + snooze + visibility-throttle behaviors are testable in
// the `dom` vitest project without booting the Nuxt runtime.
//
// The plugin wires this controller to `$fetch('/api/version')`, the Nuxt
// toast composable, and `window.location.reload()`. The controller never
// imports any of those — every side-effect goes through the deps object,
// which is what the tests stub.

export interface VersionCheckDeps {
  /** Returns the current server build id, or null on transport failure. */
  fetchBuildId: () => Promise<string | null>
  /** Triggered when the auto-reload timer fires or the user clicks "Reload now". */
  reload: () => void
  /** Used to render the prompt. The controller is agnostic to UI shape. */
  showPrompt: (handlers: VersionCheckPromptHandlers) => void
  /** Wraps `Date.now` so tests can drive the visibility-throttle deterministically. */
  now?: () => number
}

export interface VersionCheckPromptHandlers {
  /** User clicked the primary "Reload now" action. */
  onReloadNow: () => void
  /** User clicked "Snooze 5 min" — auto-reload is deferred. */
  onSnooze: () => void
}

export interface VersionCheckOptions {
  pollIntervalMs?: number
  graceMs?: number
  snoozeMs?: number
  visibilityThrottleMs?: number
}

export interface VersionCheckController {
  /** Run one /api/version probe. No-op if the prompt has already been shown. */
  poll: () => Promise<void>
  /** Call when the tab returns to visible. Polls if past the throttle window. */
  onVisible: () => void
  /** Tear down all timers. Safe to call multiple times. */
  dispose: () => void
}

export const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000
export const DEFAULT_GRACE_MS = 30 * 1000
export const DEFAULT_SNOOZE_MS = 5 * 60 * 1000
export const DEFAULT_VISIBILITY_THROTTLE_MS = 60 * 1000

export function createVersionCheckController(
  deps: VersionCheckDeps,
  opts: VersionCheckOptions = {}
): VersionCheckController {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS
  const snoozeMs = opts.snoozeMs ?? DEFAULT_SNOOZE_MS
  const visibilityThrottleMs = opts.visibilityThrottleMs ?? DEFAULT_VISIBILITY_THROTTLE_MS
  const now = deps.now ?? (() => Date.now())

  let baseline: string | null = null
  let shown = false
  let pollInterval: ReturnType<typeof setInterval> | null = null
  let reloadTimer: ReturnType<typeof setTimeout> | null = null
  let lastPolledAt = 0

  function clearReloadTimer() {
    if (reloadTimer) {
      clearTimeout(reloadTimer)
      reloadTimer = null
    }
  }

  function scheduleReload(delayMs: number) {
    clearReloadTimer()
    reloadTimer = setTimeout(() => {
      reloadTimer = null
      deps.reload()
    }, delayMs)
  }

  function showPromptOnce() {
    if (shown) return
    shown = true
    if (pollInterval) {
      clearInterval(pollInterval)
      pollInterval = null
    }
    scheduleReload(graceMs)
    deps.showPrompt({
      onReloadNow: () => {
        clearReloadTimer()
        deps.reload()
      },
      onSnooze: () => {
        scheduleReload(snoozeMs)
      }
    })
  }

  async function poll(): Promise<void> {
    if (shown) return
    lastPolledAt = now()
    let buildId: string | null = null
    try {
      buildId = await deps.fetchBuildId()
    } catch {
      return
    }
    if (!buildId) return
    if (baseline === null) {
      baseline = buildId
      return
    }
    if (buildId === baseline) return
    showPromptOnce()
  }

  function onVisible() {
    if (shown) return
    if (now() - lastPolledAt < visibilityThrottleMs) return
    void poll()
  }

  // Kick off interval. Caller is responsible for the first poll —
  // tests want explicit control over the first probe so they don't
  // race against the interval.
  pollInterval = setInterval(() => {
    void poll()
  }, pollIntervalMs)

  return {
    poll,
    onVisible,
    dispose() {
      if (pollInterval) {
        clearInterval(pollInterval)
        pollInterval = null
      }
      clearReloadTimer()
    }
  }
}
