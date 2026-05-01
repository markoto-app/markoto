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

beforeEach(() => {
  sessionStub = {
    loggedIn: { value: true },
    clear: vi.fn(async () => { sessionStub.loggedIn.value = false })
  }
  navigateToStub = vi.fn(async () => {})

  // Nuxt auto-imports — these are normally injected by the framework.
  ;(globalThis as unknown as { useUserSession: () => SessionStub }).useUserSession = () => sessionStub
  ;(globalThis as unknown as { navigateTo: typeof navigateToStub }).navigateTo = navigateToStub

  // Seed storage so we can observe the clear.
  localStorage.setItem('foo', 'bar')
  sessionStorage.setItem('baz', 'qux')
})

afterEach(() => {
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
    // navigateTo ran — meaning the pipeline didn't bail.
    await expect(performLogout()).resolves.toBeUndefined()
    expect(sessionStub.clear).toHaveBeenCalledTimes(1)
    expect(navigateToStub).toHaveBeenCalledWith('/')
    Storage.prototype.clear = orig
  })
})

// ─────────────────────────────────────────────────────────────────────
// BroadcastChannel
// ─────────────────────────────────────────────────────────────────────

describe('performLogout — BroadcastChannel', () => {
  it('posts a logged-out message on the markoto-auth channel', async () => {
    const messages: unknown[] = []
    const listener = new BroadcastChannel(LOGOUT_CHANNEL_NAME)
    listener.addEventListener('message', (e: MessageEvent) => {
      messages.push(e.data)
    })

    await performLogout()
    // Allow the BroadcastChannel async dispatch to run.
    await new Promise<void>(resolve => setTimeout(resolve, 0))

    expect(messages).toContainEqual({ type: 'logged-out' })
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
    expect(navigateToStub).toHaveBeenCalledWith('/')
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
  it('clears the session and navigates to /', async () => {
    await performLogout()
    expect(sessionStub.clear).toHaveBeenCalledTimes(1)
    expect(navigateToStub).toHaveBeenCalledWith('/')
  })

  it('navigates AFTER clearing the session (so middleware sees anon)', async () => {
    const order: string[] = []
    sessionStub.clear = vi.fn(async () => {
      order.push('clear')
    })
    navigateToStub = vi.fn(async () => {
      order.push('nav')
    })
    ;(globalThis as unknown as { navigateTo: typeof navigateToStub }).navigateTo = navigateToStub
    await performLogout()
    expect(order).toEqual(['clear', 'nav'])
  })
})
