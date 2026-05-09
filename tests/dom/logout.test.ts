import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { performLogout, LOGOUT_CHANNEL_NAME, LOGOUT_IDB_PREFIX } from '../../app/composables/useLogout'

// `useLogout`'s pipeline is the only thing standing between a logged-out
// user and a stale tab acting on their behalf, so the tests here pin
// every observable side-effect: storage scrubbing, IDB scrubbing,
// BroadcastChannel post, awareness teardown ordering, and the final
// session.clear() + redirect.
//
// The composable references three Nuxt globals (`useUserSession`,
// `navigateTo`) that don't exist in the `dom` project. We stub them on
// `globalThis` before importing the SUT — happy-dom's flat global is
// the same surface auto-imports would resolve against.

// ─────────────────────────────────────────────────────────────────────
// Test doubles for Nuxt auto-imports
// ─────────────────────────────────────────────────────────────────────

interface SessionStub {
  loggedIn: { value: boolean }
  clear: ReturnType<typeof vi.fn>
}

let sessionStub: SessionStub
let navigateToStub: ReturnType<typeof vi.fn>
// `useLogout` does a hard reload (`window.location.href = '/'`) on
// the client to throw away ALL Vue state on logout — the soft
// `navigateTo` path only runs in SSR. We stub both: the location
// setter is what the tests primarily assert against; navigateTo
// is kept as a fallback for the SSR contract test.
let locationHrefSetter: ReturnType<typeof vi.fn>
let originalLocation: Location

beforeEach(() => {
  sessionStub = {
    loggedIn: { value: true },
    clear: vi.fn(async () => { sessionStub.loggedIn.value = false })
  }
  navigateToStub = vi.fn(async () => {})

  // Nuxt auto-imports — these are normally injected by the framework.
  ;(globalThis as unknown as { useUserSession: () => SessionStub }).useUserSession = () => sessionStub
  ;(globalThis as unknown as { navigateTo: typeof navigateToStub }).navigateTo = navigateToStub

  // Stub window.location.href so we can observe the hard-reload
  // assignment without triggering a real navigation in happy-dom.
  originalLocation = window.location
  locationHrefSetter = vi.fn()
  Object.defineProperty(window, 'location', {
    value: {
      get href() { return '/' },
      set href(v: string) { locationHrefSetter(v) }
    },
    writable: true,
    configurable: true
  })

  // Seed storage so we can observe the clear.
  localStorage.setItem('foo', 'bar')
  sessionStorage.setItem('baz', 'qux')
})

afterEach(() => {
  // Restore window.location so other tests in the same file aren't
  // running with the stubbed setter.
  Object.defineProperty(window, 'location', {
    value: originalLocation,
    writable: true,
    configurable: true
  })
  localStorage.clear()
  sessionStorage.clear()
  vi.restoreAllMocks()
})

// ─────────────────────────────────────────────────────────────────────
// Storage scrub
// ─────────────────────────────────────────────────────────────────────

describe('performLogout — storage scrub', () => {
  it('clears localStorage', async () => {
    expect(localStorage.getItem('foo')).toBe('bar')
    await performLogout()
    expect(localStorage.getItem('foo')).toBeNull()
    expect(localStorage.length).toBe(0)
  })

  it('clears sessionStorage', async () => {
    expect(sessionStorage.getItem('baz')).toBe('qux')
    await performLogout()
    expect(sessionStorage.getItem('baz')).toBeNull()
    expect(sessionStorage.length).toBe(0)
  })

  it('soft-fails if localStorage.clear throws (e.g. storage disabled)', async () => {
    const orig = Storage.prototype.clear
    Storage.prototype.clear = vi.fn(() => {
      throw new Error('disabled')
    })
    // Must not throw. We can still observe that session.clear() and
    // the hard reload ran — meaning the pipeline didn't bail.
    await expect(performLogout()).resolves.toBeUndefined()
    expect(sessionStub.clear).toHaveBeenCalledTimes(1)
    expect(locationHrefSetter).toHaveBeenCalledWith('/')
    Storage.prototype.clear = orig
  })
})

// ─────────────────────────────────────────────────────────────────────
// BroadcastChannel
// ─────────────────────────────────────────────────────────────────────

describe('performLogout — BroadcastChannel', () => {
  it('posts a logged-out message on the markoto-auth channel', async () => {
    // Subscribe BEFORE performLogout so the listener is wired by the time
    // the post fires. We resolve on the actual message event instead of
    // waiting a fixed `setTimeout(0)` — under coverage instrumentation in
    // CI the event-loop pressure pushes the BroadcastChannel async
    // dispatch past a single macro-tick, and the old version flaked.
    const listener = new BroadcastChannel(LOGOUT_CHANNEL_NAME)
    const received = new Promise<unknown>((resolve, reject) => {
      listener.addEventListener('message', (e: MessageEvent) => resolve(e.data))
      setTimeout(() => reject(new Error('logged-out broadcast not received within 1000ms')), 1000)
    })

    await performLogout()

    await expect(received).resolves.toEqual({ type: 'logged-out' })
    listener.close()
  })

  it('uses exactly the channel name a global listener would subscribe to', () => {
    // Sanity: the constant is the contract between sender + receiver.
    expect(LOGOUT_CHANNEL_NAME).toBe('markoto-auth')
  })

  it('soft-fails if BroadcastChannel construction throws', async () => {
    const original = globalThis.BroadcastChannel
    ;(globalThis as unknown as { BroadcastChannel: unknown }).BroadcastChannel = function () {
      throw new Error('blocked')
    }
    await expect(performLogout()).resolves.toBeUndefined()
    expect(sessionStub.clear).toHaveBeenCalledTimes(1)
    ;(globalThis as unknown as { BroadcastChannel: unknown }).BroadcastChannel = original
  })
})

// ─────────────────────────────────────────────────────────────────────
// Awareness teardown ordering
// ─────────────────────────────────────────────────────────────────────

describe('performLogout — beforeClear hook', () => {
  it('runs beforeClear before useUserSession().clear()', async () => {
    const order: string[] = []
    sessionStub.clear = vi.fn(async () => {
      order.push('session.clear')
      sessionStub.loggedIn.value = false
    })
    await performLogout({
      beforeClear: () => { order.push('beforeClear') }
    })
    expect(order).toEqual(['beforeClear', 'session.clear'])
  })

  it('swallows beforeClear errors (logout proceeds)', async () => {
    await expect(performLogout({
      beforeClear: () => { throw new Error('awareness already gone') }
    })).resolves.toBeUndefined()
    expect(sessionStub.clear).toHaveBeenCalledTimes(1)
    expect(locationHrefSetter).toHaveBeenCalledWith('/')
  })

  it('awaits async beforeClear hooks before clearing the session', async () => {
    const order: string[] = []
    sessionStub.clear = vi.fn(async () => {
      order.push('session.clear')
    })
    await performLogout({
      beforeClear: async () => {
        await new Promise<void>(r => setTimeout(r, 5))
        order.push('beforeClear-done')
      }
    })
    expect(order).toEqual(['beforeClear-done', 'session.clear'])
  })
})

// ─────────────────────────────────────────────────────────────────────
// IndexedDB scrub
// ─────────────────────────────────────────────────────────────────────

describe('performLogout — IndexedDB', () => {
  it('deletes only IDB databases with the markoto- prefix', async () => {
    const deleted: string[] = []
    const fakeIdb = {
      databases: vi.fn(async () => [
        { name: 'markoto-doc-cache' },
        { name: 'markoto-awareness' },
        { name: 'unrelated-extension-db' },
        { name: undefined } // some browsers report nameless system DBs
      ]),
      deleteDatabase: vi.fn((name: string) => { deleted.push(name) })
    }
    const original = globalThis.indexedDB
    ;(globalThis as unknown as { indexedDB: typeof fakeIdb }).indexedDB = fakeIdb

    await performLogout()
    expect(fakeIdb.databases).toHaveBeenCalledTimes(1)
    expect(deleted).toEqual(['markoto-doc-cache', 'markoto-awareness'])
    expect(deleted).not.toContain('unrelated-extension-db')

    ;(globalThis as unknown as { indexedDB: typeof original }).indexedDB = original
  })

  it('soft-fails when indexedDB.databases() is missing (Safari, older Firefox)', async () => {
    const original = globalThis.indexedDB
    ;(globalThis as unknown as { indexedDB: object }).indexedDB = {
      // No `databases` method present.
      deleteDatabase: vi.fn()
    }
    await expect(performLogout()).resolves.toBeUndefined()
    expect(sessionStub.clear).toHaveBeenCalledTimes(1)
    ;(globalThis as unknown as { indexedDB: typeof original }).indexedDB = original
  })

  it('LOGOUT_IDB_PREFIX is the markoto- prefix the cleanup will match', () => {
    expect(LOGOUT_IDB_PREFIX).toBe('markoto-')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Session clear + navigation
// ─────────────────────────────────────────────────────────────────────

describe('performLogout — session + redirect', () => {
  // The current-tab redirect uses `window.location.href = '/'` (a
  // hard reload) rather than `navigateTo('/')` (a soft SPA route).
  // The hard reload throws away ALL Vue state — `loggedIn` ref,
  // billing/account-status `useState` snapshots, the editor's
  // awareness handle, etc. — so the page bootstraps cleanly
  // anonymous. The soft path was leaving the topbar showing a
  // stale avatar + triggering 401 toasts.
  it('clears the session and reloads the page to /', async () => {
    await performLogout()
    expect(sessionStub.clear).toHaveBeenCalledTimes(1)
    expect(locationHrefSetter).toHaveBeenCalledWith('/')
    // navigateTo is the SSR fallback path; never reached on the
    // client since `typeof window !== 'undefined'`.
    expect(navigateToStub).not.toHaveBeenCalled()
  })

  it('reloads AFTER clearing the session (so the next request is anon)', async () => {
    const order: string[] = []
    sessionStub.clear = vi.fn(async () => {
      order.push('clear')
    })
    locationHrefSetter.mockImplementation(() => {
      order.push('nav')
    })
    await performLogout()
    expect(order).toEqual(['clear', 'nav'])
  })
})
