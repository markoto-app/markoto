import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { MINUTE_MS } from '~~/shared/config/units'

// Process-level Y.Doc connection pool. Two consumers:
//
//   1. The in-app agentic loop, `createAiSession` checks out an entry
//      with principalId `loop:{loopSessionId}`, holds it for the loop
//      duration, releases on `destroy()`. Each loop run has a unique
//      principalId so cache hits never happen for the loop, the pool
//      is just a clean API boundary that future refactors can leverage.
//
//   2. MCP tool wrappers, each MCP session has a stable principalId
//      `mcp:{mcpSessionId}`. Repeated tool calls on the same doc within
//      a session reuse the warm entry. Eviction kicks in 5 min after
//      the last release. **This is where the pool actually saves
//      handshakes** (~200-500ms each).
//
// The (docId, principalId) key shape avoids two real problems we'd hit
// with a docId-only key:
//   - **Awareness contention**: each principal wants its own
//     `setLocalStateField('aiStatus' | 'mcpStatus', ...)` slot. A shared
//     awareness instance would have last-writer-wins collisions.
//   - **JWT identity**: loop uses `ai:assistant:{sessionId}` for
//     activity-log attribution; MCP uses `mcp:{mcpSessionId}`. Different
//     principals → different JWTs → different providers → different
//     pool entries.
//
// Concurrent-checkout safety: an in-flight Map dedups concurrent
// checkouts of the same key so two callers don't race to open two
// providers for the same principal. Both await the same promise and
// share the resulting entry.
//
// Eviction: refCount=0 entries past `IDLE_MS` are closed by the sweeper
// in `server/plugins/yDocPoolSweep.ts`. Pool is process-local; no
// advisory lock needed (multi-instance behavior is each process owns
// its own connections, which is fine, Hocuspocus dedupes on its end).
//
// MULTI-INSTANCE NOTE (read before scaling out): each Nuxt process
// runs its own pool. An MCP session whose first tool call lands on
// process A and whose second lands on process B will pay the handshake
// cost twice: sticky sessions at Traefik (already in
// deploy/compose/compose.prod.yml for the `sync` service; NOT for the `app`
// service) would prevent this. When we move to multi-app-instance,
// add `traefik.http.services.app.loadbalancer.sticky.cookie=true` so
// MCP requests for the same `Mcp-Session-Id` route to the same Nuxt
// container. Until then we're single-instance, so this is theoretical.

export interface PoolKey {
  docId: string
  principalId: string
}

export interface PoolCheckoutOpts {
  /**
   * JWT signed with `config.jwtSecret` carrying the principal's claims, or
   * a function minting one. Pass a function for anything that may stay
   * connected longer than one token lives: the provider calls it on every
   * (re)connect and when the sync server asks for a fresh token before
   * expiry (it closes connections whose token runs out).
   */
  jwt: string | (() => string)
  /** Awareness `user` field broadcast to other clients. */
  awarenessUser: {
    name: string
    color: string
    isAI?: boolean
  }
  /** Optional extra awareness fields the consumer wants set BEFORE the first sync. */
  awarenessExtra?: Record<string, unknown>
  /** Internal Hocuspocus URL (ws://...). Defaults to runtime config. */
  syncUrl: string
  /** Hard sync deadline. Default 10s. */
  syncTimeoutMs?: number
}

export interface PoolEntry {
  ydoc: Y.Doc
  ytext: Y.Text
  ymeta: Y.Map<unknown>
  awareness: Awareness
  provider: HocuspocusProvider
  /** Resolved at checkout time; never mutated by the pool itself. */
  readonly key: PoolKey
  /** Active checkouts. ≥1 = in use; 0 = idle, eligible for eviction. */
  refCount: number
  /** ms epoch when refCount last hit 0. Sweeper compares against IDLE_MS. */
  lastReleasedAt: number
  /** ms epoch when the entry was created. For observability + leak detection. */
  readonly createdAt: number
}

const DEFAULT_SYNC_TIMEOUT_MS = 10_000
const DEFAULT_IDLE_MS = 5 * MINUTE_MS

function serializeKey(k: PoolKey): string {
  // Principal IDs already carry a colon (`loop:{...}` / `mcp:{...}`) so
  // we use a separator that can't collide. docId is lowercase nanoid in
  // production but tests use arbitrary strings, `|` is reserved here
  // and will never appear in either component.
  return `${k.docId}|${k.principalId}`
}

// Module-level state. Singleton per process by virtue of ESM module
// caching. Tests reset via `_resetForTesting()`.
const entries = new Map<string, PoolEntry>()
const inflight = new Map<string, Promise<PoolEntry>>()

/**
 * Open a new HocuspocusProvider, set awareness, await sync. Promise
 * rejects on auth failure, transport close before sync, or timeout.
 *
 * Pure constructor: no pool state mutation. Pool wires in refCount +
 * lastReleasedAt around this.
 */
async function buildEntry(key: PoolKey, opts: PoolCheckoutOpts): Promise<PoolEntry> {
  const ydoc = new Y.Doc()
  const awareness = new Awareness(ydoc)

  awareness.setLocalStateField('user', {
    name: opts.awarenessUser.name,
    color: opts.awarenessUser.color,
    ...(opts.awarenessUser.isAI ? { isAI: true } : {})
  })
  if (opts.awarenessExtra) {
    for (const [field, value] of Object.entries(opts.awarenessExtra)) {
      awareness.setLocalStateField(field, value)
    }
  }

  let syncResolved = false
  let resolveSync!: () => void
  let rejectSync!: (e: Error) => void
  const syncReady = new Promise<void>((resolve, reject) => {
    resolveSync = resolve
    rejectSync = reject
  })
  const syncTimeoutMs = opts.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS
  const timer = setTimeout(() => {
    if (syncResolved) return
    syncResolved = true
    rejectSync(new Error(`[yDocPool] sync timeout (${syncTimeoutMs}ms) for ${serializeKey(key)}`))
  }, syncTimeoutMs)

  const provider = new HocuspocusProvider({
    url: opts.syncUrl,
    name: key.docId,
    document: ydoc,
    awareness,
    token: opts.jwt,
    onSynced: () => {
      if (syncResolved) return
      syncResolved = true
      clearTimeout(timer)
      resolveSync()
    },
    onAuthenticationFailed: (data) => {
      if (syncResolved) return
      syncResolved = true
      clearTimeout(timer)
      rejectSync(new Error(`[yDocPool] auth failed for ${serializeKey(key)}: ${data?.reason ?? 'unknown'}`))
    },
    onClose: (data) => {
      const evt = (data as { event?: { code?: number, reason?: string } })?.event
      if (syncResolved) return
      syncResolved = true
      clearTimeout(timer)
      rejectSync(new Error(`[yDocPool] connection closed for ${serializeKey(key)}: ${evt?.code ?? '?'} ${evt?.reason ?? ''}`))
    }
  })

  try {
    await syncReady
  } catch (err) {
    // Sync never completed: tear down what we built so we don't leak
    // a half-open provider. The caller still gets the rejection.
    try {
      provider.disconnect()
    } catch { /* best-effort */ }
    try {
      provider.destroy()
    } catch { /* best-effort */ }
    try {
      ydoc.destroy()
    } catch { /* best-effort */ }
    throw err
  }

  return {
    ydoc,
    ytext: ydoc.getText('content'),
    ymeta: ydoc.getMap<unknown>('meta'),
    awareness,
    provider,
    key,
    refCount: 0,
    lastReleasedAt: 0,
    createdAt: Date.now()
  }
}

/**
 * Check out a pool entry for the given (docId, principalId). Existing
 * entries return immediately with refCount++; missing entries are
 * created (concurrent calls dedupe via the in-flight Map). The caller
 * MUST call `release(key)` when done, leaks pin connections forever.
 */
export async function checkout(key: PoolKey, opts: PoolCheckoutOpts): Promise<PoolEntry> {
  const k = serializeKey(key)

  const existing = entries.get(k)
  if (existing) {
    existing.refCount++
    return existing
  }

  const pending = inflight.get(k)
  if (pending) {
    const entry = await pending
    entry.refCount++
    return entry
  }

  // `buildEntryDispatch` routes to `_buildEntryOverride` when a test has
  // installed one, falling back to the real `buildEntry`. Production
  // callers never see this branch.
  const promise = buildEntryDispatch(key, opts).then(
    (entry) => {
      entry.refCount = 1
      entries.set(k, entry)
      inflight.delete(k)
      return entry
    },
    (err) => {
      inflight.delete(k)
      throw err
    }
  )
  inflight.set(k, promise)
  return promise
}

/**
 * Decrement refCount on the entry for `key`. When refCount hits 0,
 * stamp `lastReleasedAt` so the sweeper can evict after IDLE_MS. No-op
 * for unknown keys (idempotent, releasing twice is safe but logs in
 * a future observability step).
 */
export function release(key: PoolKey): void {
  const k = serializeKey(key)
  const e = entries.get(k)
  if (!e) return
  if (e.refCount <= 0) {
    // Defensive: over-releasing shouldn't push refCount negative or
    // restamp lastReleasedAt (which would defer eviction indefinitely).
    return
  }
  e.refCount--
  if (e.refCount === 0) {
    e.lastReleasedAt = Date.now()
  }
}

/**
 * Close + remove every entry whose refCount=0 AND has been idle longer
 * than `maxIdleMs`. Returns the number evicted. Sweeper hook.
 *
 * Provider/Y.Doc teardown is best-effort wrapped (mirrors the
 * `createAiSession` destroy semantics) so a single failure doesn't
 * leak siblings.
 */
export function evictIdle(maxIdleMs: number = DEFAULT_IDLE_MS): number {
  const now = Date.now()
  let evicted = 0
  for (const [k, e] of entries) {
    if (e.refCount > 0) continue
    if (now - e.lastReleasedAt < maxIdleMs) continue
    closeEntry(e)
    entries.delete(k)
    evicted++
  }
  return evicted
}

function closeEntry(e: PoolEntry): void {
  try {
    e.awareness.setLocalState(null)
  } catch { /* best-effort */ }
  try {
    e.provider.disconnect()
  } catch { /* best-effort */ }
  try {
    e.provider.destroy()
  } catch { /* best-effort */ }
  try {
    e.ydoc.destroy()
  } catch { /* best-effort */ }
}

/**
 * Force-close every entry regardless of refCount. For graceful shutdown
 * (the `99-shutdown.ts` plugin) and for test teardown.
 */
export function closeAll(): void {
  for (const e of entries.values()) closeEntry(e)
  entries.clear()
  inflight.clear()
}

/** Snapshot for observability + tests. Don't mutate the returned data. */
export function getPoolStats(): {
  size: number
  refCountTotal: number
  inflightCount: number
  oldestIdleMs: number | null
} {
  let refCountTotal = 0
  let oldestIdleMs: number | null = null
  const now = Date.now()
  for (const e of entries.values()) {
    refCountTotal += e.refCount
    if (e.refCount === 0 && e.lastReleasedAt > 0) {
      const idle = now - e.lastReleasedAt
      if (oldestIdleMs === null || idle > oldestIdleMs) oldestIdleMs = idle
    }
  }
  return {
    size: entries.size,
    refCountTotal,
    inflightCount: inflight.size,
    oldestIdleMs
  }
}

/**
 * @internal Test-only: drops every entry without invoking destroy.
 * Use `closeAll()` in production code; this skips teardown so unit tests
 * that swap the buildEntry mock with an in-memory Y.Doc don't trip on
 * provider.destroy() against a non-existent connection.
 */
export function _resetForTesting(): void {
  entries.clear()
  inflight.clear()
}

/**
 * @internal Test-only: replaces the buildEntry implementation so unit
 * tests can exercise the pool's bookkeeping (refCount, in-flight dedup,
 * idle eviction) without spawning a real Hocuspocus connection.
 *
 * Call this BEFORE any checkout() in the test, and call it with `null`
 * in afterEach to restore the real implementation.
 */
let _buildEntryOverride: ((key: PoolKey, opts: PoolCheckoutOpts) => Promise<PoolEntry>) | null = null
export function _setBuildEntryForTesting(override: typeof _buildEntryOverride): void {
  _buildEntryOverride = override
}

// Test-injection seam used by `checkout` above.
async function buildEntryDispatch(key: PoolKey, opts: PoolCheckoutOpts): Promise<PoolEntry> {
  if (_buildEntryOverride) return _buildEntryOverride(key, opts)
  return buildEntry(key, opts)
}
