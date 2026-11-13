import { migrationsComplete } from './migrations'
import { acquireSweepLock, releaseSweepLock } from '../../repos/sweepLocks'
import { captureExceptionThrottled } from './throttledSentry'
import { useLogger } from './logger'

/**
 * One body for every periodic background job started by a Nitro plugin
 * (`server/plugins/*`): startup delay, interval, no overlapping runs within
 * the instance, a Postgres advisory lock so only one app instance runs the
 * job, one log line per run, throttled Sentry capture and clean shutdown.
 * The schedule lives in `server/config/sweeps.ts`.
 *
 * A plugin file is therefore only:
 *
 *   export default defineSweeper({
 *     name: 'waitlist-sweep',
 *     schedule: SWEEPS.waitlist,
 *     run: runWaitlistSweep
 *   })
 */

/** Structural subset of the Nitro app the helper needs (keeps it unit-testable). */
interface SweeperHost {
  hooks: { hook: (name: 'close', fn: () => void | Promise<void>) => unknown }
}

export interface SweeperOptions {
  /** Log `component`, Sentry `component` tag AND the advisory-lock key. Renaming it changes the lock key, which two app versions running side by side (a rolling deploy) would no longer share. */
  name: string
  schedule: { intervalMs: number, startupDelayMs?: number }
  /** Evaluated once at boot; false → nothing is scheduled. Read config here, not at module scope. */
  enabled?: () => boolean
  /** Runs once at boot, only when enabled (e.g. a warning about half-configured settings). */
  setup?: () => void
  /** Evaluated every tick BEFORE the lock is taken; false → the tick is skipped without touching the database. */
  shouldRun?: () => boolean
  /** First run after boot (after `startupDelayMs` when the schedule has one). false → the first run is one interval after boot. Default true. */
  runAtBoot?: boolean
  /** Take the cross-instance advisory lock named `name`. false only for process-local work. Default true. */
  lock?: boolean
  /** Wait for `00-db-migrate` before a run. false for work that never touches the database. Default true. */
  awaitMigrations?: boolean
  /** Send a failed run to Sentry. false where a failure is an expected transient (LiteLLM still starting). It is still logged. Default true. */
  reportErrors?: boolean
  /** Extra shutdown work, after the timers are cleared. */
  onClose?: () => void | Promise<void>
  /** The work (sync or async). Return a summary object to get it logged; return nothing to stay silent. Throw to fail the run. */
  run: () => unknown
}

export function defineSweeper(options: SweeperOptions): (nitroApp: SweeperHost) => void {
  const {
    name,
    schedule,
    runAtBoot = true,
    lock = true,
    awaitMigrations = true,
    reportErrors = true
  } = options
  // One component per sweeper, so `docker logs | jq 'select(.component == "waitlist-sweep")'` finds its runs.
  const log = useLogger(name)

  return (nitroApp) => {
    // `bun run build` boots Nitro in prerender mode and runs every plugin;
    // there is no database then, and a timer must not outlive the build.
    if (import.meta.prerender) return
    if (options.enabled && !options.enabled()) return
    options.setup?.()

    let running = false
    let closed = false

    async function tick(): Promise<void> {
      // `running`: a run slower than the interval must not start a second
      // one in this process (the advisory lock only covers other instances).
      if (closed || running) return
      if (options.shouldRun && !options.shouldRun()) return
      running = true
      const started = Date.now()
      let locked = false
      try {
        if (awaitMigrations) await migrationsComplete
        // A shutdown during the migration wait must not start a run against a
        // pool that is closing.
        if (closed) return
        if (lock) {
          // Held elsewhere (normal multi-instance case) or locking degraded:
          // acquireSweepLock already reported the latter; skip quietly.
          if (!await acquireSweepLock(name)) return
          locked = true
        }
        const summary = await options.run()
        if (summary && typeof summary === 'object') {
          log.info('run finished', { durationMs: Date.now() - started, ...summary })
        }
      } catch (e) {
        log.warn('run failed', { durationMs: Date.now() - started, err: e })
        if (reportErrors) {
          captureExceptionThrottled(`sweep:${name}`, e, { tags: { component: name, event: 'sweep_failed' } })
        }
      } finally {
        if (locked) await releaseSweepLock(name)
        running = false
      }
    }

    const timers: Array<ReturnType<typeof setTimeout>> = []
    if (runAtBoot) timers.push(setTimeout(() => void tick(), schedule.startupDelayMs ?? 0))
    const interval = setInterval(() => void tick(), schedule.intervalMs)
    timers.push(interval)
    // Never keep the process alive just for a sweep.
    for (const t of timers) t.unref?.()

    nitroApp.hooks.hook('close', async () => {
      closed = true
      for (const t of timers) {
        clearTimeout(t)
        clearInterval(t)
      }
      await options.onClose?.()
    })
  }
}
