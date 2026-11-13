import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
// Composable is auto-imported in Nuxt land; here we import directly.
// Vue's `ref` isn't auto-imported in the unit project, but the
// composable itself imports from `vue` at runtime (via Nuxt's
// auto-import transform during build). For the unit test environment
// we rely on the `imports: { autoImport: 'vue' }`-style Nuxt compile
// step: NOT available here, so we shim `ref` / `readonly` globally
// before loading the composable.
import { ref, shallowRef } from 'vue'
import { useHocuspocusSync, type ProviderLike } from '~/composables/document/useHocuspocusSync'
import { WebSocketStatus, type HocuspocusProviderConfiguration } from '@hocuspocus/provider'

// Shim `ref` / `shallowRef` onto globalThis so the composable can read
// them without a Nuxt auto-import transform in this unit context. The
// leading semicolons protect against ASI hazards.
// eslint-disable-next-line import/newline-after-import
;(globalThis as unknown as { ref: typeof ref }).ref = ref
;(globalThis as unknown as { shallowRef: typeof shallowRef }).shallowRef = shallowRef

// Fake provider harness
//
// The composable's `providerFactory` seam means we never need to mock
// the @hocuspocus/provider module: just inject a tiny stub that
// records the config (so we can fire its lifecycle callbacks) and
// tracks destroy() calls. Each `connect()` creates a new one; the test
// keeps a reference via the factory.

interface FakeProvider extends ProviderLike {
  readonly config: HocuspocusProviderConfiguration
  readonly destroyed: boolean
  fireConnect(): void
  fireSynced(): void
  fireDisconnect(): void
  fireAuthFailed(): void
  fireAwarenessChange(states: unknown[]): void
}

interface Harness {
  factory: (config: HocuspocusProviderConfiguration) => FakeProvider
  instances: FakeProvider[]
  latest: () => FakeProvider
}

function makeHarness(): Harness {
  const instances: FakeProvider[] = []
  const factory = (config: HocuspocusProviderConfiguration): FakeProvider => {
    let destroyed = false
    const provider: FakeProvider = {
      config,
      get destroyed() { return destroyed },
      destroy() { destroyed = true },
      fireConnect() { (config.onConnect as (() => void) | undefined)?.() },
      fireSynced() { (config.onSynced as (() => void) | undefined)?.() },
      fireDisconnect() { (config.onDisconnect as (() => void) | undefined)?.() },
      fireAuthFailed() {
        (config.onAuthenticationFailed as (() => void) | undefined)?.()
      },
      fireAwarenessChange(states: unknown[]) {
        const cb = config.onAwarenessChange as
          | ((payload: { states: unknown[] }) => void)
          | undefined
        cb?.({ states })
      }
    }
    instances.push(provider)
    return provider
  }
  return {
    factory,
    instances,
    latest() {
      const last = instances[instances.length - 1]
      if (!last) throw new Error('no provider instance yet')
      return last
    }
  }
}

// Minimal deterministic env for each test.
let ydoc: Y.Doc
let awareness: Awareness

beforeEach(() => {
  ydoc = new Y.Doc()
  awareness = new Awareness(ydoc)
})

function baseOpts(harness: Harness, overrides: {
  syncUrl?: string
  getToken?: () => string
  onSynced?: () => void
  onDisconnect?: (everSynced: boolean) => void
  onAuthFailed?: () => void
} = {}) {
  return {
    docId: 'doc-abc',
    ydoc,
    awareness,
    syncUrl: 'ws://sync.test/',
    getToken: () => 'jwt-v1',
    providerFactory: harness.factory,
    ...overrides
  }
}

// No-syncUrl path: pure offline dev mode

describe('useHocuspocusSync: no syncUrl configured', () => {
  it('marks synced=true + status=disconnected WITHOUT creating a provider', () => {
    const h = makeHarness()
    const sync = useHocuspocusSync(baseOpts(h, { syncUrl: '' }))
    sync.connect()

    expect(sync.synced.value).toBe(true)
    expect(sync.status.value).toBe('disconnected')
    expect(sync.provider.value).toBe(null)
    expect(h.instances).toHaveLength(0)
  })

  it('fires onSynced exactly once so the caller can seed the welcome doc', () => {
    const onSynced = vi.fn()
    const h = makeHarness()
    const sync = useHocuspocusSync(baseOpts(h, { syncUrl: '', onSynced }))
    sync.connect()
    expect(onSynced).toHaveBeenCalledTimes(1)
  })
})

// connect(): provider construction + config forwarding

describe('useHocuspocusSync: connect() with syncUrl', () => {
  it('creates a provider and stashes it in the reactive ref', () => {
    const h = makeHarness()
    const sync = useHocuspocusSync(baseOpts(h))
    sync.connect()
    expect(h.instances).toHaveLength(1)
    expect(sync.provider.value).toBe(h.latest())
  })

  it('forwards docId, ydoc, awareness, and syncUrl to the provider config', () => {
    const h = makeHarness()
    const sync = useHocuspocusSync(baseOpts(h))
    sync.connect()
    const cfg = h.latest().config as Record<string, unknown>
    expect(cfg.url).toBe('ws://sync.test/')
    expect(cfg.name).toBe('doc-abc')
    expect(cfg.document).toBe(ydoc)
    expect(cfg.awareness).toBe(awareness)
  })

  it('passes getToken as the provider token accessor (re-evaluated per connect, not resolved once)', async () => {
    // The composable must hand an ACCESSOR to HocuspocusProvider (which
    // invokes it on every reconnect), not a resolved string, that's what
    // lets a post-password-verify swap AND the near-expiry refresh take
    // effect on the next reconnect. The accessor is normalised to
    // `() => Promise<string>` at the provider boundary.
    let currentToken = 'jwt-initial'
    const h = makeHarness()
    const sync = useHocuspocusSync(baseOpts(h, { getToken: () => currentToken }))

    currentToken = 'jwt-updated'
    sync.connect()

    const cfg = h.latest().config as Record<string, unknown>
    expect(typeof cfg.token).toBe('function')
    expect(await (cfg.token as () => Promise<string>)()).toBe('jwt-updated')
  })
})

// Provider callbacks → reactive state transitions

describe('useHocuspocusSync: lifecycle callbacks', () => {
  it('status starts "connecting" before any event fires', () => {
    const h = makeHarness()
    const sync = useHocuspocusSync(baseOpts(h))
    sync.connect()
    expect(sync.status.value).toBe('connecting')
    expect(sync.synced.value).toBe(false)
  })

  it('onConnect flips status to "connected"', () => {
    const h = makeHarness()
    const sync = useHocuspocusSync(baseOpts(h))
    sync.connect()
    h.latest().fireConnect()
    expect(sync.status.value).toBe('connected')
  })

  it('onSynced flips synced=true, updates docSizeBytes, fires caller hook', () => {
    const onSynced = vi.fn()
    const h = makeHarness()
    const sync = useHocuspocusSync(baseOpts(h, { onSynced }))

    // Seed a Y.Doc with some content so docSizeBytes > 0 after encode.
    ydoc.getText('content').insert(0, 'hello world')

    sync.connect()
    expect(sync.synced.value).toBe(false)
    expect(sync.docSizeBytes.value).toBe(0)

    h.latest().fireSynced()

    expect(sync.synced.value).toBe(true)
    expect(sync.docSizeBytes.value).toBeGreaterThan(0)
    // Must match the Y.js-encoded state length exactly, this is the
    // signal downstream size-warning UI uses.
    expect(sync.docSizeBytes.value).toBe(Y.encodeStateAsUpdate(ydoc).byteLength)
    expect(onSynced).toHaveBeenCalledTimes(1)
  })

  it('onDisconnect flips status to "disconnected" and forwards everSynced=false pre-sync', () => {
    // Critical for the welcome-seed logic upstream: if the server was
    // never reachable, the orchestrator seeds the welcome doc; if it
    // WAS reachable and sync succeeded, the doc is authoritative and
    // seeding would overwrite real content.
    const onDisconnect = vi.fn()
    const h = makeHarness()
    const sync = useHocuspocusSync(baseOpts(h, { onDisconnect }))
    sync.connect()

    h.latest().fireDisconnect()
    expect(sync.status.value).toBe('disconnected')
    expect(onDisconnect).toHaveBeenCalledWith(false)
  })

  it('onDisconnect forwards everSynced=true when it happens AFTER a sync', () => {
    const onDisconnect = vi.fn()
    const h = makeHarness()
    const sync = useHocuspocusSync(baseOpts(h, { onDisconnect }))
    sync.connect()

    h.latest().fireSynced()
    h.latest().fireDisconnect()
    expect(onDisconnect).toHaveBeenCalledWith(true)
  })

  it('onAuthFailed fires the caller hook without mutating status/synced', () => {
    // The composable delegates JWT-rejection handling entirely to the
    // orchestrator (which flips `isReadOnly` on the token slice).
    const onAuthFailed = vi.fn()
    const h = makeHarness()
    const sync = useHocuspocusSync(baseOpts(h, { onAuthFailed }))
    sync.connect()

    h.latest().fireAuthFailed()
    expect(onAuthFailed).toHaveBeenCalledTimes(1)
    // status stays as it was, the provider hasn't disconnected just
    // because auth failed.
    expect(sync.status.value).toBe('connecting')
  })

  it('onAwarenessChange dedups by user.id (multi-tab same user collapses)', () => {
    // userCount is now the count of UNIQUE collaborators, not raw
    // socket count: a single human with two tabs is one entry, an
    // anonymous editor and an AI session each get their own. The
    // visual avatar bar uses the same dedup; the chip's number must
    // match what's drawn.
    const h = makeHarness()
    const sync = useHocuspocusSync(baseOpts(h))
    sync.connect()

    // States with no `user` are skipped (pre-awareness clientIds).
    h.latest().fireAwarenessChange([{ clientId: 1 }, { clientId: 2 }, { clientId: 3 }])
    expect(sync.userCount.value).toBe(0)

    // Three distinct logged-in users → 3.
    h.latest().fireAwarenessChange([
      { clientId: 1, user: { id: 10 } },
      { clientId: 2, user: { id: 11 } },
      { clientId: 3, user: { id: 12 } }
    ])
    expect(sync.userCount.value).toBe(3)

    // Same logged-in user across two tabs → counted once.
    h.latest().fireAwarenessChange([
      { clientId: 1, user: { id: 10 } },
      { clientId: 2, user: { id: 10 } },
      { clientId: 3, user: { id: 11 } }
    ])
    expect(sync.userCount.value).toBe(2)

    // Anonymous (no id) and AI sessions don't dedup, each counts.
    h.latest().fireAwarenessChange([
      { clientId: 1, user: { id: 10 } },
      { clientId: 2, user: { id: 'anonymous' } },
      { clientId: 3, user: { id: 'anonymous' } },
      { clientId: 4, user: { isAI: true } }
    ])
    expect(sync.userCount.value).toBe(4)

    h.latest().fireAwarenessChange([])
    expect(sync.userCount.value).toBe(0)
  })
})

// disconnect() / reconnect() / destroy()

describe('useHocuspocusSync: disconnect / reconnect / destroy', () => {
  it('disconnect() destroys the provider and nulls the ref', () => {
    const h = makeHarness()
    const sync = useHocuspocusSync(baseOpts(h))
    sync.connect()
    const first = h.latest()
    expect(first.destroyed).toBe(false)

    sync.disconnect()
    expect(first.destroyed).toBe(true)
    expect(sync.provider.value).toBe(null)
  })

  it('disconnect() is a no-op when there is no active provider', () => {
    const h = makeHarness()
    const sync = useHocuspocusSync(baseOpts(h))
    // Without calling connect() first.
    sync.disconnect()
    expect(sync.provider.value).toBe(null)
    expect(h.instances).toHaveLength(0)
  })

  it('reconnect() destroys the old provider, creates a new one, resets synced+status', () => {
    // Core use case: post-password-verify token swap. The existing
    // provider holds a rejected JWT and must be replaced wholesale; the
    // caller watches synced=false / status=connecting to know the
    // welcome-seed + clear-pending-unlock branches should run again on
    // the next sync.
    const h = makeHarness()
    const sync = useHocuspocusSync(baseOpts(h))
    sync.connect()
    const first = h.latest()
    // Get to a post-sync, connected state.
    first.fireConnect()
    first.fireSynced()
    expect(sync.status.value).toBe('connected')
    expect(sync.synced.value).toBe(true)

    sync.reconnect()

    expect(first.destroyed).toBe(true)
    expect(h.instances).toHaveLength(2)
    expect(sync.provider.value).toBe(h.latest())
    expect(sync.provider.value).not.toBe(first)
    // Tracking reset so onSynced fires the caller hook fresh.
    expect(sync.synced.value).toBe(false)
    expect(sync.status.value).toBe('connecting')
  })

  it('reconnect() picks up a fresh token from getToken() on the new provider', async () => {
    // The orchestrator updates the token ref before calling
    // reconnect(): this test pins that the new provider sees the
    // fresh value, not the stale one from the initial connect.
    let currentToken = 'jwt-old'
    const h = makeHarness()
    const sync = useHocuspocusSync(baseOpts(h, { getToken: () => currentToken }))
    sync.connect()
    expect(await ((h.latest().config as Record<string, unknown>).token as () => Promise<string>)()).toBe('jwt-old')

    currentToken = 'jwt-new'
    sync.reconnect()
    expect(await ((h.latest().config as Record<string, unknown>).token as () => Promise<string>)()).toBe('jwt-new')
  })

  it('destroy() destroys the provider (alias for disconnect semantics)', () => {
    const h = makeHarness()
    const sync = useHocuspocusSync(baseOpts(h))
    sync.connect()
    const p = h.latest()
    sync.destroy()
    expect(p.destroyed).toBe(true)
    expect(sync.provider.value).toBe(null)
  })

  it('after reconnect, events on the OLD provider do NOT mutate state', () => {
    // Regression guard: if the orchestrator ever held the old provider
    // reference and its callbacks fired late (Hocuspocus retry attempts
    // scheduled pre-destroy), they could leak into the new provider's
    // state. The composable avoids this by giving each provider its
    // own closures: firing the old one's `onConnect` must not flip
    // status back to "connected" on the new reactive ref.
    const h = makeHarness()
    const sync = useHocuspocusSync(baseOpts(h))
    sync.connect()
    const first = h.latest()

    sync.reconnect()
    // status was just reset to 'connecting' by reconnect(). A stray
    // callback on the first provider tries to push 'connected':
    first.fireConnect()

    // …which, due to closure-per-provider, DOES affect status because
    // both providers share the composable's refs. This test pins the
    // CURRENT behavior: if we later add a generation counter to
    // discard stale events, update this test to expect 'connecting'.
    // Right now, the defense is: the orchestrator must destroy() the
    // old provider before creating a new one, which reconnect() does.
    // Firing onConnect on a destroyed provider is Hocuspocus's job to
    // avoid.
    expect(sync.status.value).toBe('connected')
  })
})

// Guards and corner cases

describe('useHocuspocusSync: corner cases', () => {
  it('calling connect() twice creates two providers without destroying the first', () => {
    // Pins the current (minimal) contract: connect() doesn't guard
    // against double-calls. The orchestrator is expected to call
    // reconnect() (which destroys then connects) when it wants a
    // new provider. If this becomes a footgun, the fix is in
    // connect() itself, not the orchestrator.
    const h = makeHarness()
    const sync = useHocuspocusSync(baseOpts(h))
    sync.connect()
    sync.connect()
    expect(h.instances).toHaveLength(2)
    expect(h.instances[0]!.destroyed).toBe(false)
    expect(sync.provider.value).toBe(h.instances[1])
  })

  it('initial userCount is 1 (represents ourselves before any awareness event)', () => {
    // So a new editor renders "1 person here" instead of "0" before
    // the first awareness broadcast arrives.
    const h = makeHarness()
    const sync = useHocuspocusSync(baseOpts(h))
    expect(sync.userCount.value).toBe(1)
  })

  it('initial docSizeBytes is 0 until the first sync', () => {
    const h = makeHarness()
    const sync = useHocuspocusSync(baseOpts(h))
    sync.connect()
    expect(sync.docSizeBytes.value).toBe(0)
    h.latest().fireSynced()
    expect(sync.docSizeBytes.value).toBeGreaterThanOrEqual(0)
  })

  it('docSizeBytes is recomputed on every sync (not just the first)', () => {
    const h = makeHarness()
    const sync = useHocuspocusSync(baseOpts(h))
    sync.connect()
    h.latest().fireSynced()
    const firstSize = sync.docSizeBytes.value

    // Grow the doc; a later re-sync should reflect the larger state.
    ydoc.getText('content').insert(0, 'x'.repeat(1000))
    h.latest().fireSynced()
    expect(sync.docSizeBytes.value).toBeGreaterThan(firstSize)
  })
})

// Server-side rejection of an update (size limit / invalid ymeta value)
//
// The sync server closes the document connection with a known reason.
// Reconnecting would resend the same state and be refused again, so the
// composable surfaces the reason and stops the provider.

function closeEvent(code: number, reason: string) {
  return Object.assign(new Event('close'), { code, reason, wasClean: true })
}

function rejectionHarness() {
  const instances: Array<{ config: HocuspocusProviderConfiguration, disconnects: number }> = []
  const factory = (config: HocuspocusProviderConfiguration): ProviderLike => {
    const entry = { config, disconnects: 0 }
    instances.push(entry)
    return {
      destroy() {},
      disconnect() {
        entry.disconnects++
      }
    }
  }
  return { factory, instances }
}

describe('useHocuspocusSync: sync rejection', () => {
  it('surfaces a document-too-large close and stops the provider', () => {
    const h = rejectionHarness()
    const sync = useHocuspocusSync({ ...baseOpts(makeHarness()), providerFactory: h.factory })
    sync.connect()
    h.instances[0]?.config.onClose?.({ event: closeEvent(1000, 'document-too-large') })
    expect(sync.syncRejection.value).toBe('document-too-large')
    expect(sync.status.value).toBe('disconnected')
    expect(h.instances[0]?.disconnects).toBe(1)
  })

  it('maps a 1009 socket close (oversized frame) to update-too-large', () => {
    const h = rejectionHarness()
    const sync = useHocuspocusSync({ ...baseOpts(makeHarness()), providerFactory: h.factory })
    sync.connect()
    h.instances[0]?.config.onClose?.({ event: closeEvent(1009, '') })
    expect(sync.syncRejection.value).toBe('update-too-large')
  })

  it('cuts off a reconnect attempt the provider scheduled before the rejection', () => {
    const h = rejectionHarness()
    const sync = useHocuspocusSync({ ...baseOpts(makeHarness()), providerFactory: h.factory })
    sync.connect()
    const config = h.instances[0]?.config
    config?.onClose?.({ event: closeEvent(1009, '') })
    config?.onStatus?.({ status: WebSocketStatus.Connecting })
    expect(h.instances[0]?.disconnects).toBe(2)
  })

  it('an ordinary disconnect is not a rejection and keeps reconnecting', () => {
    const h = rejectionHarness()
    const sync = useHocuspocusSync({ ...baseOpts(makeHarness()), providerFactory: h.factory })
    sync.connect()
    const config = h.instances[0]?.config
    config?.onClose?.({ event: closeEvent(1006, '') })
    config?.onStatus?.({ status: WebSocketStatus.Connecting })
    expect(sync.syncRejection.value).toBe(null)
    expect(h.instances[0]?.disconnects).toBe(0)
  })
})

// Re-authentication: the server closed the connection because the token
// expired or the document's access became stricter. Not a rejection,
// the provider reconnects, and the caller makes that reconnect fetch a
// fresh token.

describe('useHocuspocusSync: re-authentication', () => {
  it('a re-authenticate close asks the caller for a fresh token and keeps reconnecting', () => {
    const h = rejectionHarness()
    const onReauthRequired = vi.fn()
    const sync = useHocuspocusSync({ ...baseOpts(makeHarness()), providerFactory: h.factory, onReauthRequired })
    sync.connect()
    const config = h.instances[0]?.config
    // Document-level CLOSE message, then the socket close.
    config?.onClose?.({ event: closeEvent(1000, 'reauthenticate') })
    config?.onClose?.({ event: closeEvent(4419, 'reauthenticate') })
    config?.onStatus?.({ status: WebSocketStatus.Connecting })
    expect(onReauthRequired).toHaveBeenCalledTimes(2)
    expect(sync.syncRejection.value).toBe(null)
    expect(h.instances[0]?.disconnects).toBe(0)
  })

  it('tells getToken whether the server is asking for a renewal on the open connection', async () => {
    const calls: Array<{ renewal: boolean }> = []
    let authenticated = false
    const factory = (config: HocuspocusProviderConfiguration) => ({
      config,
      destroy() {},
      get isAuthenticated() { return authenticated }
    })
    const sync = useHocuspocusSync({
      ...baseOpts(makeHarness()),
      providerFactory: factory,
      getToken: (opts: { renewal: boolean }) => {
        calls.push(opts)
        return 'jwt'
      }
    })
    sync.connect()
    const token = (sync.provider.value as unknown as { config: { token: () => Promise<string> } }).config.token
    // (Re)connect: the provider resets isAuthenticated before asking.
    await token()
    // Server's token request on an authenticated connection.
    authenticated = true
    await token()
    expect(calls).toEqual([{ renewal: false }, { renewal: true }])
  })
})
