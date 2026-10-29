import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { nextTick } from 'vue'

// — import AFTER mocks are in place ————————————————————————————————
import { useDocument } from '~/composables/useDocument'
import { defaultTheme } from '~~/shared/utils/defaultTheme'

// Orchestrator tests for `useDocument`. The strategy:
//
//   - Mock `useDocToken` and `useHocuspocusSync` so we control their
//     reactive state + capture the callbacks the orchestrator wires in.
//   - Mock `useUserSession` + `useRuntimeConfig` + `useDebounceFn` so
//     the orchestrator gets its ambient Nuxt dependencies.
//   - Register a stub `/api/docs/:id/meta` endpoint so the PUT calls
//     from setTheme/resetTheme hit something deterministic.
//
// Everything else (Y.Doc, Awareness, observer wiring, computed derivation)
// runs for real — the tests exercise the orchestrator's own logic, not
// any sub-composable's.

// — hoisted state + helpers that mocks close over ——————————————————

// All reactive state uses real Vue refs so the orchestrator's computeds
// (canEditTheme, docSizeWarning) re-run when tests mutate dependencies.
// Plain `{value}` objects looked ref-shaped but had no reactive tracking.
const hoisted = vi.hoisted(() => {
  // Re-import to avoid cross-module cycle issues at hoist time.
  // vi.hoisted runs above all imports so we defer the vue import via
  // require-at-eval-time pattern that Vitest supports.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ref, shallowRef } = require('vue') as typeof import('vue')
  return {
    sessionUser: ref<{ id: number, name?: string, avatar?: string } | null>(null),
    loggedIn: ref(false),
    tokenState: {
      tokenData: ref<{ token: string, readOnly: boolean } | null>({ token: 'jwt-v1', readOnly: false }),
      isReadOnly: ref(false),
      isOwner: ref(false),
      hasOwner: ref(false),
      requiresPassword: ref(false),
      forbidden: ref(false),
      canDelete: ref(false),
      notFound: ref(false),
      accessMode: ref<string>('open-edit'),
      pendingPasswordUnlock: ref(false),
      initialTheme: shallowRef<unknown>(null),
      initialTitle: ref<string>(''),
      initialDescription: ref<string>(''),
      initialAudience: ref<string>('casual'),
      initialLanguage: ref<string>('en'),
      initialBody: ref<string | null>(null)
    },
    tokenMocks: {
      fetchToken: vi.fn<() => Promise<void>>(() => Promise.resolve()),
      hydrateAfterUnlock: vi.fn<(t: string) => Promise<void>>(() => Promise.resolve()),
      onPasswordVerified: vi.fn<(t: string) => void>(),
      clearPendingUnlock: vi.fn<() => void>(),
      markReadOnly: vi.fn<() => void>(),
      setAccessMode: vi.fn<(m: string) => void>()
    },
    syncState: {
      docSizeBytes: ref(0),
      status: ref<'connecting' | 'connected' | 'disconnected'>('connecting'),
      synced: ref(false),
      userCount: ref(1),
      provider: shallowRef<unknown>(null)
    },
    syncMocks: {
      connect: vi.fn<() => void>(),
      disconnect: vi.fn<() => void>(),
      reconnect: vi.fn<() => void>(),
      destroy: vi.fn<() => void>()
    },
    // Captured opts passed into useHocuspocusSync — gives tests the
    // hook handles so they can simulate provider lifecycle events.
    metaCalls: [] as Array<{ url: string, method: string, body: unknown }>,
    debounce: { deferred: false, pending: null as null | (() => unknown) },
    capturedSyncOpts: null as null | {
      docId: string
      syncUrl: string
      getToken: () => string | Promise<string>
      onSynced?: () => void
      onDisconnect?: (everSynced: boolean) => void
      onAuthFailed?: () => void
    }
  }
})

mockNuxtImport('useUserSession', () => {
  return () => ({
    user: hoisted.sessionUser,
    loggedIn: hoisted.loggedIn
  })
})

mockNuxtImport('useRuntimeConfig', () => {
  // Mocking `useRuntimeConfig` wholesale replaces EVERYTHING — including
  // the defaults Nuxt's core plugins depend on (router reads
  // `config.app.baseURL` during setup, for instance). Provide a minimal
  // complete shape so those plugins don't blow up at app-init time.
  return () => ({
    app: { baseURL: '/', buildId: 'test', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { syncUrl: 'ws://sync.test/' }
  })
})

// Bypass the 800ms debounce so tests can assert the PUT synchronously.
// The real useDebounceFn wraps the arg in a leading-edge-or-trailing
// timer; an identity function matches the single-call semantics for
// tests that only fire setTheme once.
//
// `hoisted.debounce.deferred = true` switches to real debounce semantics
// (only the LAST call's arguments run, on `flushDebounced()`) for the
// doc-context merge test.
mockNuxtImport('useDebounceFn', () => {
  return <A extends unknown[]>(fn: (...args: A) => unknown) => (...args: A) => {
    if (hoisted.debounce.deferred) {
      hoisted.debounce.pending = () => fn(...args)
      return
    }
    return fn(...args)
  }
})

function flushDebounced() {
  const run = hoisted.debounce.pending
  hoisted.debounce.pending = null
  run?.()
}

mockNuxtImport('useDocToken', () => {
  return (_docId: string) => ({
    tokenData: hoisted.tokenState.tokenData,
    isReadOnly: hoisted.tokenState.isReadOnly,
    isOwner: hoisted.tokenState.isOwner,
    hasOwner: hoisted.tokenState.hasOwner,
    requiresPassword: hoisted.tokenState.requiresPassword,
    forbidden: hoisted.tokenState.forbidden,
    canDelete: hoisted.tokenState.canDelete,
    notFound: hoisted.tokenState.notFound,
    accessMode: hoisted.tokenState.accessMode,
    pendingPasswordUnlock: hoisted.tokenState.pendingPasswordUnlock,
    initialTheme: hoisted.tokenState.initialTheme,
    initialTitle: hoisted.tokenState.initialTitle,
    initialDescription: hoisted.tokenState.initialDescription,
    initialAudience: hoisted.tokenState.initialAudience,
    initialLanguage: hoisted.tokenState.initialLanguage,
    initialBody: hoisted.tokenState.initialBody,
    fetchToken: hoisted.tokenMocks.fetchToken,
    hydrateAfterUnlock: hoisted.tokenMocks.hydrateAfterUnlock,
    // Faithful stub of the real getFreshToken happy path — return the
    // current token. The refetch-near-expiry behaviour is pinned against
    // the real implementation in tests/nuxt/useDocToken.test.ts.
    getFreshToken: () => Promise.resolve(hoisted.tokenState.tokenData.value?.token || ''),
    onPasswordVerified: hoisted.tokenMocks.onPasswordVerified,
    clearPendingUnlock: hoisted.tokenMocks.clearPendingUnlock,
    markReadOnly: hoisted.tokenMocks.markReadOnly,
    setAccessMode: hoisted.tokenMocks.setAccessMode
  })
})

mockNuxtImport('useHocuspocusSync', () => {
  return (opts: Parameters<typeof hoisted.capturedSyncOpts extends null ? never : never>) => {
    hoisted.capturedSyncOpts = opts as NonNullable<typeof hoisted.capturedSyncOpts>
    return {
      provider: hoisted.syncState.provider,
      status: hoisted.syncState.status,
      synced: hoisted.syncState.synced,
      userCount: hoisted.syncState.userCount,
      docSizeBytes: hoisted.syncState.docSizeBytes,
      connect: hoisted.syncMocks.connect,
      disconnect: hoisted.syncMocks.disconnect,
      reconnect: hoisted.syncMocks.reconnect,
      destroy: hoisted.syncMocks.destroy
    }
  }
})

// — $fetch stub for meta PUT ——————————————————————————————————————
// We can't use registerEndpoint here: the server-side auth middleware
// rejects `/api/docs/*` PUTs without a real session cookie before our
// handler runs. Mocking `useUserSession` only changes client-side state.
// Mocking `$fetch` intercepts the call before it hits the network/Nitro
// entirely — good enough for recording body + URL.
//
// Since Nuxt 4.5, `$fetch` in app code is an auto-import (nuxt/nuxt#35581)
// rather than a read of the global, so `vi.stubGlobal('$fetch', …)` no
// longer reaches `useDocument`; it has to be mocked as a Nuxt import.
interface MetaCall { url: string, method: string, body: unknown }
const metaCalls: MetaCall[] = hoisted.metaCalls

mockNuxtImport('$fetch', () => {
  return async (url: string, opts?: { method?: string, body?: unknown }) => {
    if (/^\/api\/docs\/[^/]+\/meta$/.test(url) && opts?.method === 'PUT') {
      hoisted.metaCalls.push({ url, method: opts.method, body: opts.body })
      return { ok: true }
    }
    // useDocument's only $fetch is the owner meta PUT; anything else is
    // a test-setup gap and should fail loudly rather than hit Nitro.
    throw new Error(`unexpected $fetch in useDocument test: ${opts?.method ?? 'GET'} ${url}`)
  }
})

function resetHoisted() {
  hoisted.sessionUser.value = null
  hoisted.loggedIn.value = false
  hoisted.tokenState.tokenData.value = { token: 'jwt-v1', readOnly: false }
  hoisted.tokenState.isReadOnly.value = false
  hoisted.tokenState.isOwner.value = false
  hoisted.tokenState.hasOwner.value = false
  hoisted.tokenState.requiresPassword.value = false
  hoisted.tokenState.forbidden.value = false
  hoisted.tokenState.notFound.value = false
  hoisted.tokenState.accessMode.value = 'open-edit'
  hoisted.tokenState.pendingPasswordUnlock.value = false
  hoisted.tokenState.initialTheme.value = null
  hoisted.tokenState.initialTitle.value = ''
  hoisted.tokenState.initialDescription.value = ''
  hoisted.tokenState.initialAudience.value = 'casual'
  hoisted.tokenMocks.fetchToken.mockReset().mockImplementation(() => Promise.resolve())
  hoisted.tokenMocks.onPasswordVerified.mockReset()
  hoisted.tokenMocks.hydrateAfterUnlock.mockReset().mockImplementation(() => Promise.resolve())
  hoisted.tokenMocks.clearPendingUnlock.mockReset()
  hoisted.tokenMocks.markReadOnly.mockReset()
  hoisted.tokenMocks.setAccessMode.mockReset()
  hoisted.syncState.docSizeBytes.value = 0
  hoisted.syncState.status.value = 'connecting'
  hoisted.syncState.synced.value = false
  hoisted.syncState.userCount.value = 1
  hoisted.syncState.provider.value = null
  hoisted.syncMocks.connect.mockReset()
  hoisted.syncMocks.disconnect.mockReset()
  hoisted.syncMocks.reconnect.mockReset()
  hoisted.syncMocks.destroy.mockReset()
  hoisted.capturedSyncOpts = null
  hoisted.debounce.deferred = false
  hoisted.debounce.pending = null
  metaCalls.length = 0
}

beforeEach(() => {
  resetHoisted()
})

/**
 * Helper: wait for `useDocument`'s fetchToken().then(...) chain to
 * settle. The orchestrator kicks off an async chain inside setup() —
 * tests that assert about `sync.connect()` being called (or not) need
 * to yield a few microtasks first.
 */
async function flushFetchToken() {
  await nextTick()
  await Promise.resolve()
  await Promise.resolve()
}

// ═══════════════════════════════════════════════════════════════════════
// Initial connect gating
// ═══════════════════════════════════════════════════════════════════════

describe('useDocument — initial connect gating', () => {
  it('calls sync.connect() after fetchToken resolves for a normal doc', async () => {
    const doc = useDocument('doc-abc')
    await flushFetchToken()
    expect(hoisted.tokenMocks.fetchToken).toHaveBeenCalledTimes(1)
    expect(hoisted.syncMocks.connect).toHaveBeenCalledTimes(1)
    doc.destroy()
  })

  it('does NOT connect when the doc is forbidden (private, non-owner)', async () => {
    hoisted.tokenState.forbidden.value = true
    const doc = useDocument('doc-abc')
    await flushFetchToken()
    expect(hoisted.syncMocks.connect).not.toHaveBeenCalled()
    doc.destroy()
  })

  it('does NOT connect when the doc is not found (an empty-token connect would just churn)', async () => {
    hoisted.tokenState.notFound.value = true
    const doc = useDocument('doc-abc')
    await flushFetchToken()
    expect(hoisted.syncMocks.connect).not.toHaveBeenCalled()
    expect(doc.notFound.value).toBe(true)
    doc.destroy()
  })

  it('does NOT connect when the doc requires a password', async () => {
    hoisted.tokenState.requiresPassword.value = true
    const doc = useDocument('doc-abc')
    await flushFetchToken()
    expect(hoisted.syncMocks.connect).not.toHaveBeenCalled()
    doc.destroy()
  })

  it('seeds _themeRef from initialTheme when the /token response includes one', async () => {
    // Mutate a real schema field so the seed passes isValidTheme
    // (.strict() rejects unknown keys, so a synthetic `marker` won't work).
    const seeded = structuredClone(defaultTheme)
    seeded.body.font = 'Merriweather'
    hoisted.tokenState.initialTheme.value = seeded
    const doc = useDocument('doc-abc')
    await flushFetchToken()
    expect(doc.theme.value.body.font).toBe('Merriweather')
    doc.destroy()
  })

  it('leaves _themeRef as defaultTheme when initialTheme is null or invalid', async () => {
    hoisted.tokenState.initialTheme.value = { garbage: true }
    const doc = useDocument('doc-abc')
    await flushFetchToken()
    // Vue's `ref<DocTheme>(defaultTheme)` wraps the object in a reactive
    // Proxy, so `toBe(defaultTheme)` fails on identity. Content equality
    // is what matters: the invalid initialTheme was rejected and the
    // default is the surviving theme.
    expect(doc.theme.value).toEqual(defaultTheme)
    doc.destroy()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Sync lifecycle callbacks wired by useDocument
// ═══════════════════════════════════════════════════════════════════════

describe('useDocument — sync lifecycle wiring', () => {
  it('onSynced inserts welcome content when the doc is empty + writable', async () => {
    const doc = useDocument('doc-abc')
    await flushFetchToken()
    expect(doc.ytext.length).toBe(0)

    hoisted.capturedSyncOpts!.onSynced!()
    expect(doc.ytext.length).toBeGreaterThan(0)
    // Welcome content contains the header.
    expect(doc.ytext.toString()).toContain('Welcome to markoto')
    doc.destroy()
  })

  it('onSynced does NOT insert welcome when the doc already has content', async () => {
    const doc = useDocument('doc-abc')
    await flushFetchToken()
    doc.ytext.insert(0, 'hand-typed content')
    const before = doc.ytext.toString()

    hoisted.capturedSyncOpts!.onSynced!()
    expect(doc.ytext.toString()).toBe(before)
    doc.destroy()
  })

  it('onSynced does NOT insert welcome when read-only (viewer shouldn\'t seed)', async () => {
    hoisted.tokenState.isReadOnly.value = true
    const doc = useDocument('doc-abc')
    await flushFetchToken()

    hoisted.capturedSyncOpts!.onSynced!()
    expect(doc.ytext.length).toBe(0)
    doc.destroy()
  })

  it('onSynced calls tokenState.clearPendingUnlock (for the post-password-verify flip)', async () => {
    const doc = useDocument('doc-abc')
    await flushFetchToken()
    hoisted.capturedSyncOpts!.onSynced!()
    expect(hoisted.tokenMocks.clearPendingUnlock).toHaveBeenCalled()
    doc.destroy()
  })

  it('does NOT wire an onDisconnect seed (F9: never seed without an authoritative sync)', async () => {
    // The welcome seed must run ONLY from onSynced. useDocument must not
    // pass an onDisconnect handler that writes to the Y.Doc — a pre-sync
    // disconnect seed would merge with the server's real content when the
    // provider auto-reconnects and finally syncs, corrupting the doc.
    const doc = useDocument('doc-abc')
    await flushFetchToken()
    expect(hoisted.capturedSyncOpts!.onDisconnect).toBeUndefined()
    // The doc stays empty on a disconnect-before-sync; nothing seeds it.
    expect(doc.ytext.length).toBe(0)
    doc.destroy()
  })

  it('seeds on onSynced even if a disconnect happened first (server recovered, still empty)', async () => {
    // A transient outage on first load must not lose the welcome seed: once
    // a real sync lands and finds the doc empty, it seeds authoritatively.
    const doc = useDocument('doc-abc')
    await flushFetchToken()
    expect(doc.ytext.length).toBe(0)

    hoisted.capturedSyncOpts!.onSynced!()
    expect(doc.ytext.toString()).toContain('Welcome to markoto')
    doc.destroy()
  })

  it('onAuthFailed calls tokenState.markReadOnly', async () => {
    const doc = useDocument('doc-abc')
    await flushFetchToken()
    hoisted.capturedSyncOpts!.onAuthFailed!()
    expect(hoisted.tokenMocks.markReadOnly).toHaveBeenCalledTimes(1)
    doc.destroy()
  })

  it('forwards the CURRENT token via getToken() (not a stale snapshot)', async () => {
    // getToken now delegates to tokenState.getFreshToken() (async) so the
    // provider re-reads a possibly-refreshed JWT on every reconnect (F5).
    hoisted.tokenState.tokenData.value = { token: 'initial', readOnly: false }
    const doc = useDocument('doc-abc')
    await flushFetchToken()
    expect(await hoisted.capturedSyncOpts!.getToken()).toBe('initial')

    hoisted.tokenState.tokenData.value = { token: 'rotated', readOnly: false }
    expect(await hoisted.capturedSyncOpts!.getToken()).toBe('rotated')
    doc.destroy()
  })

  it('getToken() returns empty string when tokenData is null or missing', async () => {
    hoisted.tokenState.tokenData.value = null
    const doc = useDocument('doc-abc')
    await flushFetchToken()
    expect(await hoisted.capturedSyncOpts!.getToken()).toBe('')
    doc.destroy()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Title bridge (ymeta ↔ Vue ref)
// ═══════════════════════════════════════════════════════════════════════

describe('useDocument — title bridge', () => {
  it('title defaults to "Untitled" when ymeta has no title', async () => {
    const doc = useDocument('doc-abc')
    await flushFetchToken()
    expect(doc.title.value).toBe('Untitled')
    doc.destroy()
  })

  it('title shows the DB title from /token while ymeta has no title (new-document dialog)', async () => {
    hoisted.tokenState.initialTitle.value = 'Project kickoff notes'
    const doc = useDocument('doc-abc')
    await flushFetchToken()
    expect(doc.title.value).toBe('Project kickoff notes')
    // Showing it must not write ymeta — no spurious title.changed activity.
    expect(doc.ydoc.getMap('meta').get('title')).toBeUndefined()
    doc.destroy()
  })

  it('a live ymeta title wins over the DB title', async () => {
    hoisted.tokenState.initialTitle.value = 'From the dialog'
    const doc = useDocument('doc-abc')
    await flushFetchToken()
    doc.ydoc.getMap('meta').set('title', 'Renamed later')
    await nextTick()
    expect(doc.title.value).toBe('Renamed later')
    doc.destroy()
  })

  it('title updates when ymeta.title changes (observer pushes to ref)', async () => {
    const doc = useDocument('doc-abc')
    await flushFetchToken()
    doc.ydoc.getMap('meta').set('title', 'My Document')
    await nextTick()
    expect(doc.title.value).toBe('My Document')
    doc.destroy()
  })

  it('setting title via computed writes through to ymeta', async () => {
    const doc = useDocument('doc-abc')
    await flushFetchToken()
    doc.title.value = 'Renamed'
    expect(doc.ydoc.getMap('meta').get('title')).toBe('Renamed')
    doc.destroy()
  })

  it('setting title is a no-op when read-only', async () => {
    hoisted.tokenState.isReadOnly.value = true
    const doc = useDocument('doc-abc')
    await flushFetchToken()
    doc.title.value = 'Should not persist'
    // ymeta.title was never set.
    expect(doc.ydoc.getMap('meta').get('title')).toBeUndefined()
    doc.destroy()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Deletion observer
// ═══════════════════════════════════════════════════════════════════════

describe('useDocument — deletion observer', () => {
  it('isDeleted flips true when ymeta._deleted is set', async () => {
    const doc = useDocument('doc-abc')
    await flushFetchToken()
    expect(doc.isDeleted.value).toBe(false)

    doc.ydoc.getMap('meta').set('_deleted', true)
    await nextTick()
    expect(doc.isDeleted.value).toBe(true)
    doc.destroy()
  })

  it('deletedByOther stays false while this client is deleting the doc itself', async () => {
    const doc = useDocument('doc-abc')
    await flushFetchToken()
    doc.setDeletingHere(true)
    doc.ydoc.getMap('meta').set('_deleted', true)
    await nextTick()
    expect(doc.isDeleted.value).toBe(true)
    expect(doc.deletedByOther.value).toBe(false)
    doc.destroy()
  })

  it('deletedByOther flips true when someone else deletes the doc', async () => {
    const doc = useDocument('doc-abc')
    await flushFetchToken()
    doc.ydoc.getMap('meta').set('_deleted', true)
    await nextTick()
    expect(doc.deletedByOther.value).toBe(true)
    doc.destroy()
  })

  it('once isDeleted is true, it stays true (one-way latch)', async () => {
    // Even if _deleted is later unset (shouldn\'t happen in prod but
    // pin the invariant), the client stays in the "deleted" state.
    const doc = useDocument('doc-abc')
    await flushFetchToken()
    doc.ydoc.getMap('meta').set('_deleted', true)
    await nextTick()
    expect(doc.isDeleted.value).toBe(true)

    doc.ydoc.getMap('meta').delete('_deleted')
    await nextTick()
    expect(doc.isDeleted.value).toBe(true)
    doc.destroy()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Theme write path
// ═══════════════════════════════════════════════════════════════════════

describe('useDocument — document context persist', () => {
  it('merges description, audience and language changes into one PUT (debounce keeps all fields)', async () => {
    hoisted.tokenState.isOwner.value = true
    hoisted.tokenState.hasOwner.value = true
    hoisted.debounce.deferred = true
    const doc = useDocument('doc-abc')
    await flushFetchToken()

    doc.description.value = 'Onboarding email'
    doc.audience.value = 'marketing'
    doc.language.value = 'de'
    flushDebounced()
    await flushFetchToken()

    expect(metaCalls).toHaveLength(1)
    expect(metaCalls[0]?.body).toEqual({ description: 'Onboarding email', audience: 'marketing', language: 'de' })
    doc.destroy()
  })
})

describe('useDocument — setTheme', () => {
  it('writes to ymeta and persists when the user is the owner', async () => {
    hoisted.tokenState.isOwner.value = true
    hoisted.tokenState.hasOwner.value = true
    const doc = useDocument('doc-abc')
    await flushFetchToken()

    const next = structuredClone(defaultTheme)
    doc.setTheme(next)
    // Wait for the PUT to actually hit our stub (happens through
    // the debounced wrapper — which we've mocked to identity).
    await flushFetchToken()

    expect(doc.ydoc.getMap('meta').get('theme')).toEqual(next)
    expect(metaCalls).toHaveLength(1)
    expect(metaCalls[0]!.body).toEqual({ theme: next })
    doc.destroy()
  })

  it('writes to ymeta but DOES NOT persist on an ownerless doc', async () => {
    // Anonymous-created doc — `canEditTheme` is true (open-edit liberal
    // default), so the ymeta write happens, but PUT /meta would 403 so
    // the orchestrator skips it.
    hoisted.tokenState.isOwner.value = false
    hoisted.tokenState.hasOwner.value = false
    const doc = useDocument('doc-abc')
    await flushFetchToken()

    doc.setTheme(structuredClone(defaultTheme))
    await flushFetchToken()

    expect(doc.ydoc.getMap('meta').get('theme')).toBeDefined()
    expect(metaCalls).toHaveLength(0)
    doc.destroy()
  })

  it('is a no-op when read-only', async () => {
    hoisted.tokenState.isReadOnly.value = true
    hoisted.tokenState.isOwner.value = true
    hoisted.tokenState.hasOwner.value = true
    const doc = useDocument('doc-abc')
    await flushFetchToken()

    doc.setTheme(structuredClone(defaultTheme))
    expect(doc.ydoc.getMap('meta').get('theme')).toBeUndefined()
    expect(metaCalls).toHaveLength(0)
    doc.destroy()
  })

  it('is a no-op when a non-owner acts on an owned doc', async () => {
    hoisted.tokenState.isOwner.value = false
    hoisted.tokenState.hasOwner.value = true
    const doc = useDocument('doc-abc')
    await flushFetchToken()

    doc.setTheme(structuredClone(defaultTheme))
    expect(doc.ydoc.getMap('meta').get('theme')).toBeUndefined()
    expect(metaCalls).toHaveLength(0)
    doc.destroy()
  })

  it('rejects a structurally-invalid theme without mutating ymeta', async () => {
    hoisted.tokenState.isOwner.value = true
    hoisted.tokenState.hasOwner.value = true
    const doc = useDocument('doc-abc')
    await flushFetchToken()

    doc.setTheme({ totally: 'bogus' } as unknown as typeof defaultTheme)
    expect(doc.ydoc.getMap('meta').get('theme')).toBeUndefined()
    expect(metaCalls).toHaveLength(0)
    doc.destroy()
  })
})

describe('useDocument — resetTheme', () => {
  it('clears ymeta.theme + nulls DB for owner', async () => {
    hoisted.tokenState.isOwner.value = true
    hoisted.tokenState.hasOwner.value = true
    const doc = useDocument('doc-abc')
    await flushFetchToken()
    doc.ydoc.getMap('meta').set('theme', structuredClone(defaultTheme))
    await nextTick()

    doc.resetTheme()
    await flushFetchToken()

    expect(doc.ydoc.getMap('meta').get('theme')).toBeUndefined()
    expect(metaCalls).toHaveLength(1)
    expect(metaCalls[0]!.body).toEqual({ theme: null })
    doc.destroy()
  })

  it('clears ymeta but does NOT touch the DB for ownerless docs', async () => {
    hoisted.tokenState.isOwner.value = false
    hoisted.tokenState.hasOwner.value = false
    const doc = useDocument('doc-abc')
    await flushFetchToken()
    doc.ydoc.getMap('meta').set('theme', structuredClone(defaultTheme))

    doc.resetTheme()
    await flushFetchToken()

    expect(doc.ydoc.getMap('meta').get('theme')).toBeUndefined()
    expect(metaCalls).toHaveLength(0)
    doc.destroy()
  })

  it('is a no-op when read-only', async () => {
    hoisted.tokenState.isReadOnly.value = true
    hoisted.tokenState.isOwner.value = true
    hoisted.tokenState.hasOwner.value = true
    const doc = useDocument('doc-abc')
    await flushFetchToken()
    doc.ydoc.getMap('meta').set('theme', structuredClone(defaultTheme))

    doc.resetTheme()
    expect(doc.ydoc.getMap('meta').get('theme')).toBeDefined()
    expect(metaCalls).toHaveLength(0)
    doc.destroy()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Theme reactivity + canEditTheme derivation
// ═══════════════════════════════════════════════════════════════════════

describe('useDocument — theme reactivity', () => {
  it('theme ref updates when ymeta.theme changes via remote broadcast', async () => {
    const doc = useDocument('doc-abc')
    await flushFetchToken()
    expect(doc.theme.value).toEqual(defaultTheme)

    const next = structuredClone(defaultTheme)
    next.body.font = 'Lora'
    doc.ydoc.getMap('meta').set('theme', next)
    await nextTick()

    expect(doc.theme.value.body.font).toBe('Lora')
    doc.destroy()
  })

  it('canEditTheme reflects isReadOnly + isOwner + hasOwner', async () => {
    hoisted.tokenState.isReadOnly.value = false
    hoisted.tokenState.isOwner.value = true
    hoisted.tokenState.hasOwner.value = true
    const doc = useDocument('doc-abc')
    await flushFetchToken()
    expect(doc.canEditTheme.value).toBe(true)

    hoisted.tokenState.isReadOnly.value = true
    await nextTick()
    expect(doc.canEditTheme.value).toBe(false)
    doc.destroy()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Password verify flow
// ═══════════════════════════════════════════════════════════════════════

describe('useDocument — onPasswordVerified', () => {
  it('forwards the new token to tokenState and triggers a reconnect', async () => {
    const doc = useDocument('doc-abc')
    await flushFetchToken()

    await doc.onPasswordVerified('fresh-jwt')

    expect(hoisted.tokenMocks.hydrateAfterUnlock).toHaveBeenCalledWith('fresh-jwt')
    expect(hoisted.tokenMocks.onPasswordVerified).toHaveBeenCalledWith('fresh-jwt')
    expect(hoisted.syncMocks.reconnect).toHaveBeenCalledTimes(1)
    doc.destroy()
  })

  it('seeds the document context fetched with the unlock token before reconnecting', async () => {
    // A gated visitor's /token response carries no metadata (private doc
    // metadata stays private); after the unlock the metadata comes from
    // /meta with the new JWT and seeds the refs before sync settles.
    const doc = useDocument('doc-abc')
    await flushFetchToken()
    hoisted.tokenMocks.hydrateAfterUnlock.mockImplementation(async () => {
      hoisted.tokenState.initialDescription.value = 'Unlocked description'
      hoisted.tokenState.initialAudience.value = 'technical'
    })

    await doc.onPasswordVerified('fresh-jwt')

    expect(doc.description.value).toBe('Unlocked description')
    expect(doc.audience.value).toBe('technical')
    doc.destroy()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// destroy()
// ═══════════════════════════════════════════════════════════════════════

describe('useDocument — destroy', () => {
  it('tears down sync, awareness, and ydoc', async () => {
    const doc = useDocument('doc-abc')
    await flushFetchToken()
    const awarenessSpy = vi.spyOn(doc.awareness, 'destroy')
    const ydocSpy = vi.spyOn(doc.ydoc, 'destroy')

    doc.destroy()

    // sync.destroy is our mock — strict count is meaningful.
    expect(hoisted.syncMocks.destroy).toHaveBeenCalledTimes(1)
    // awareness.destroy and ydoc.destroy may be called more than once
    // because Y.Doc's own teardown cascades through its subdocs and
    // emits destroy events on bound observers. What matters here is
    // that the orchestrator invokes them — the redundant re-invocations
    // downstream are a no-op on Y.js's side.
    expect(awarenessSpy).toHaveBeenCalled()
    expect(ydocSpy).toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// docSizeWarning derivation pipes through from sync
// ═══════════════════════════════════════════════════════════════════════

describe('useDocument — docSizeWarning', () => {
  it('reflects sync.docSizeBytes through the shared helper thresholds', async () => {
    const doc = useDocument('doc-abc')
    await flushFetchToken()
    expect(doc.docSizeWarning.value).toBe(null)

    hoisted.syncState.docSizeBytes.value = 6 * 1024 * 1024
    await nextTick()
    expect(doc.docSizeWarning.value).toBe('warning')

    hoisted.syncState.docSizeBytes.value = 9 * 1024 * 1024
    await nextTick()
    expect(doc.docSizeWarning.value).toBe('critical')
    doc.destroy()
  })
})
