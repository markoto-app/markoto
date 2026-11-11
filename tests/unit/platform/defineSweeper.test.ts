import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineSweeper, type SweeperOptions } from '../../../server/utils/platform/defineSweeper'

const lock = vi.hoisted(() => ({
  acquire: vi.fn(async (_name: string) => true),
  release: vi.fn(async (_name: string) => {})
}))
const sentry = vi.hoisted(() => ({ capture: vi.fn() }))
const migrations = vi.hoisted(() => ({ gate: Promise.resolve() as Promise<void> }))

vi.mock('../../../server/utils/platform/sweepLock', () => ({
  acquireSweepLock: lock.acquire,
  releaseSweepLock: lock.release
}))
vi.mock('../../../server/utils/platform/throttledSentry', () => ({
  captureExceptionThrottled: sentry.capture
}))
vi.mock('../../../server/utils/platform/migrations', () => ({
  get migrationsComplete() { return migrations.gate }
}))

function makeHost() {
  const closers: Array<() => void | Promise<void>> = []
  return {
    host: { hooks: { hook: (_n: 'close', fn: () => void | Promise<void>) => {
      closers.push(fn)
    } } },
    close: async () => { for (const c of closers) await c() }
  }
}

function start(opts: Partial<SweeperOptions> & Pick<SweeperOptions, 'run'>) {
  const h = makeHost()
  defineSweeper({ name: 'test-sweep', schedule: { intervalMs: 1000 }, ...opts })(h.host)
  return h
}

describe('defineSweeper', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    lock.acquire.mockReset().mockResolvedValue(true)
    lock.release.mockReset().mockResolvedValue(undefined)
    sentry.capture.mockReset()
    migrations.gate = Promise.resolve()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('waits for the startup delay before the first run, then runs every interval', async () => {
    const run = vi.fn(async () => {})
    start({ run, schedule: { intervalMs: 10_000, startupDelayMs: 3000 } })
    await vi.advanceTimersByTimeAsync(2999)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(7000)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('runs at boot (once migrations are done) when the schedule has no delay', async () => {
    let open!: () => void
    migrations.gate = new Promise<void>((r) => {
      open = r
    })
    const run = vi.fn(async () => {})
    start({ run })
    await vi.advanceTimersByTimeAsync(0)
    expect(run).not.toHaveBeenCalled()
    open()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('runAtBoot: false waits one full interval for the first run', async () => {
    const run = vi.fn(async () => {})
    start({ run, runAtBoot: false })
    await vi.advanceTimersByTimeAsync(999)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('does not start a second run while one is still going', async () => {
    let finish!: () => void
    const run = vi.fn(() => new Promise<void>((r) => {
      finish = r
    }))
    start({ run, runAtBoot: false })
    await vi.advanceTimersByTimeAsync(3500)
    expect(run).toHaveBeenCalledTimes(1)
    expect(lock.acquire).toHaveBeenCalledTimes(1)
    finish()
    await vi.advanceTimersByTimeAsync(1000)
    expect(run).toHaveBeenCalledTimes(2)
    expect(lock.release).toHaveBeenCalledTimes(1)
  })

  it('skips quietly when another instance holds the lock', async () => {
    lock.acquire.mockResolvedValue(false)
    const run = vi.fn(async () => {})
    start({ run })
    await vi.advanceTimersByTimeAsync(0)
    expect(lock.acquire).toHaveBeenCalledWith('test-sweep')
    expect(run).not.toHaveBeenCalled()
    expect(lock.release).not.toHaveBeenCalled()
    expect(sentry.capture).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('reports a failed run once, releases the lock and still runs the next tick', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined)
    start({ run, runAtBoot: false })
    await vi.advanceTimersByTimeAsync(1000)
    expect(sentry.capture).toHaveBeenCalledTimes(1)
    expect(sentry.capture).toHaveBeenCalledWith(
      'sweep:test-sweep',
      expect.any(Error),
      { tags: { component: 'test-sweep', event: 'sweep_failed' } }
    )
    expect(lock.release).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(run).toHaveBeenCalledTimes(2)
    expect(sentry.capture).toHaveBeenCalledTimes(1)
  })

  it('reportErrors: false logs the failure but does not capture it', async () => {
    start({
      run: async () => {
        throw new Error('proxy starting')
      },
      reportErrors: false
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('proxy starting'))
    expect(sentry.capture).not.toHaveBeenCalled()
  })

  it('logs one line with the summary, and stays silent when run returns nothing', async () => {
    start({ run: async () => ({ deleted: 3 }) })
    await vi.advanceTimersByTimeAsync(0)
    expect(console.log).toHaveBeenCalledTimes(1)
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^\[test-sweep\] ok in \d+ms \{"deleted":3\}$/))
    vi.mocked(console.log).mockClear()
    start({ run: async () => {}, name: 'quiet' })
    await vi.advanceTimersByTimeAsync(0)
    expect(console.log).not.toHaveBeenCalled()
  })

  it('never schedules when disabled, and skips setup', async () => {
    const run = vi.fn(async () => {})
    const setup = vi.fn()
    start({ run, setup, enabled: () => false })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(run).not.toHaveBeenCalled()
    expect(setup).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('runs setup once when enabled', () => {
    const setup = vi.fn()
    start({ run: async () => {}, setup })
    expect(setup).toHaveBeenCalledTimes(1)
  })

  it('shouldRun false skips the tick before the lock is taken', async () => {
    const run = vi.fn(async () => {})
    start({ run, shouldRun: () => false })
    await vi.advanceTimersByTimeAsync(3000)
    expect(lock.acquire).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('lock: false and awaitMigrations: false skip both', async () => {
    migrations.gate = new Promise<void>(() => {})
    const run = vi.fn(async () => {})
    start({ run, lock: false, awaitMigrations: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)
    expect(lock.acquire).not.toHaveBeenCalled()
  })

  it('the close hook clears the timers, stops pending runs and calls onClose', async () => {
    const run = vi.fn(async () => {})
    const onClose = vi.fn()
    const h = start({ run, onClose, schedule: { intervalMs: 1000, startupDelayMs: 500 } })
    expect(vi.getTimerCount()).toBe(2)
    await h.close()
    expect(vi.getTimerCount()).toBe(0)
    expect(onClose).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(run).not.toHaveBeenCalled()
  })
})
