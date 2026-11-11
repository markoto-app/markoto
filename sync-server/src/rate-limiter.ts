// Rate limiter for Hocuspocus WebSocket connections.
//
// Two independent caps:
//   - `maxConnectionsPerIP` — protects against a single abusive IP
//     opening thousands of rooms. Counted per (socket, document), released
//     when either the document connection or the raw socket goes away.
//     Default: 20.
//   - `maxActiveRooms` — global ceiling on distinct loaded documents.
//     Protects against memory blowup when a crawler walks through random
//     doc IDs and each one spawns a Y.Doc in RAM. Default: 5000.
//
// IP extraction: `shared/utils/security/clientIp.ts#resolveClientIp` — the
// `TRUSTED_PROXY_HOPS`-th `x-forwarded-for` entry from the RIGHT (default
// 1 = the Traefik in every shipped compose file), falling back to the
// socket address when there is no header. The leftmost entry is whatever
// the client sent, so keying on it let anyone pick their own bucket.
// Requests with neither land in the shared "unknown" bucket.
//
// State is per-instance — `createRateLimiter()` returns a fresh limiter
// with isolated Maps, which is what unit tests use. Production uses the
// default singleton exported at the bottom.

import { DEFAULT_TRUSTED_PROXY_HOPS, parseTrustedProxyHops, resolveClientIp } from '../../shared/utils/security/clientIp'

// Minimal shape of Hocuspocus's onConnect/onDisconnect payload — only the
// fields we read. Avoids importing Hocuspocus's internal types (which
// shift between v3 patch releases).
interface HookData {
  request?: {
    headers?: Record<string, string | string[] | undefined>
    socket?: { remoteAddress?: string }
  }
  requestHeaders?: Record<string, string | string[] | undefined>
  socketId?: string
  documentName?: string
  connection?: { readyState?: { toString?: () => string } }
  instance?: { documents?: { size?: number } }
  __rateLimitSocketId?: string
}

// Minimal shape of the raw `ws` socket whose teardown we subscribe to.
// `close` fires for every socket — authenticated or not.
interface ClosableSocket {
  once: (event: 'close', listener: () => void) => unknown
}

export interface RateLimiterOptions {
  maxConnectionsPerIP?: number
  maxActiveRooms?: number
  /** Trusted reverse proxies in front of the sync server (default 1). */
  trustedHops?: number
}

function extractIp(data: HookData, trustedHops: number): string {
  // Read XFF from the upgrade request, not the WS socket: in prod every
  // connection arrives via Traefik, so the raw socket address is Traefik's
  // container IP for EVERY client — keyed on that, the per-IP cap would
  // act as one global cap of 20 connections. The socket address is only
  // the fallback for direct (non-proxied) connections.
  const request = data.request || { headers: data.requestHeaders }
  const headers = request?.headers || {}
  return resolveClientIp({
    forwardedFor: headers['x-forwarded-for'],
    remoteAddress: data.request?.socket?.remoteAddress,
    trustedHops
  }) ?? 'unknown'
}

/**
 * Build a rate limiter with isolated state. Default limits match
 * production; tests override with tiny numbers to exercise the caps.
 *
 * Slot lifecycle. Hocuspocus calls `onConnect` when a socket sends its
 * first auth frame for a document — BEFORE `onAuthenticate`. Its
 * `onDisconnect` hook is only wired for connections that authenticated
 * and loaded the document, so a socket whose authentication fails never
 * fires it. Releasing only from `onDisconnect` leaked one slot per failed
 * handshake, until the IP (and everyone behind the same NAT) was locked
 * out for the lifetime of the process. Slots are therefore keyed per
 * (socket, document) and released by whichever comes first:
 *   - `onDisconnect` — the document connection closed (the socket may
 *     stay open for other documents),
 *   - `onSocketClosed` — the raw WebSocket closed. Covers every teardown
 *     path, including failed authentication. Wired from the `ws` server's
 *     `connection` event in index.ts via `trackSocket`.
 * Both are idempotent, so the two paths never double-decrement.
 */
export function createRateLimiter(options: RateLimiterOptions = {}) {
  const maxConnectionsPerIP = options.maxConnectionsPerIP ?? 20
  const maxActiveRooms = options.maxActiveRooms ?? 5000
  const trustedHops = options.trustedHops ?? DEFAULT_TRUSTED_PROXY_HOPS

  const connectionsPerIP = new Map<string, number>()
  const connectionIPs = new Map<string, string>() // slot key → IP
  const socketSlots = new Map<string, Set<string>>() // socketId → slot keys
  // Upgrade request → socketId. The raw socket close only knows its
  // upgrade request; Hocuspocus hands the same request object to every
  // hook of that socket, so this is how a close finds its slots.
  const requestSockets = new WeakMap<object, string>()
  // Requests whose socket already closed. An auth frame that was being
  // processed when the socket dropped can still reach `onConnect` after
  // the close — it must not take a slot that nothing would release.
  const closedRequests = new WeakSet<object>()

  function slotKey(socketId: string, documentName: string | undefined): string {
    return `${socketId}|${documentName ?? ''}`
  }

  function releaseSlot(socketId: string, key: string): void {
    const ip = connectionIPs.get(key)
    if (!ip) return
    connectionIPs.delete(key)
    const slots = socketSlots.get(socketId)
    if (slots) {
      slots.delete(key)
      if (slots.size === 0) socketSlots.delete(socketId)
    }
    const n = (connectionsPerIP.get(ip) || 1) - 1
    if (n <= 0) {
      connectionsPerIP.delete(ip)
    } else {
      connectionsPerIP.set(ip, n)
    }
  }

  function onSocketClosed(request: object): void {
    try {
      closedRequests.add(request)
      const socketId = requestSockets.get(request)
      if (!socketId) return
      const slots = socketSlots.get(socketId)
      if (!slots) return
      for (const key of [...slots]) releaseSlot(socketId, key)
    } catch (e) {
      console.warn('[rate-limiter] onSocketClosed error:', e instanceof Error ? e.message : e)
    }
  }

  return {
    onConnect(data: HookData) {
      // Room cap first. Cheaper than the per-IP bookkeeping and protects
      // us from a distributed scan across many IPs that would each fit
      // under the per-IP cap but collectively exhaust memory.
      const roomCount = data.instance?.documents?.size
      if (typeof roomCount === 'number' && roomCount >= maxActiveRooms) {
        console.warn(`[rate-limiter] Active room cap reached (${roomCount}/${maxActiveRooms})`)
        throw new Error('Server at capacity')
      }

      try {
        const request = data.request
        // Socket already gone: nothing to count, and nothing would ever
        // release the slot.
        if (request && closedRequests.has(request)) return

        const ip = extractIp(data, trustedHops)
        // If Hocuspocus doesn't surface a socketId (hook shapes vary
        // between v3 patch releases), fall through to a monotonic token so
        // the counter still decrements correctly later.
        const socketId = data.socketId
          || data.connection?.readyState?.toString?.()
          || String(Date.now())
        const key = slotKey(socketId, data.documentName)
        // Same socket re-authenticating the same document: already counted.
        if (connectionIPs.has(key)) return

        const current = connectionsPerIP.get(ip) || 0
        if (current >= maxConnectionsPerIP) {
          console.warn(`[rate-limiter] Too many connections from ${ip}`)
          throw new Error('Too many connections')
        }
        connectionsPerIP.set(ip, current + 1)
        connectionIPs.set(key, ip)
        const slots = socketSlots.get(socketId) ?? new Set<string>()
        slots.add(key)
        socketSlots.set(socketId, slots)
        if (request) requestSockets.set(request, socketId)
        data.__rateLimitSocketId = socketId
      } catch (e) {
        if (e instanceof Error
          && (e.message === 'Too many connections' || e.message === 'Server at capacity')) {
          throw e
        }
        // Don't crash on unexpected data shape — fail-open on bookkeeping
        // errors. The cap is defence-in-depth; a wedged limiter
        // shouldn't DoS legitimate traffic.
        console.warn('[rate-limiter] onConnect error:', e instanceof Error ? e.message : e)
      }
    },

    onDisconnect(data: HookData) {
      try {
        const socketId = data.__rateLimitSocketId || data.socketId || ''
        releaseSlot(socketId, slotKey(socketId, data.documentName))
      } catch (e) {
        console.warn('[rate-limiter] onDisconnect error:', e instanceof Error ? e.message : e)
      }
    },

    /**
     * The raw WebSocket behind `request` closed. Releases every slot the
     * socket held — the path that covers sockets whose authentication
     * failed (Hocuspocus never fires `onDisconnect` for those).
     */
    onSocketClosed,

    /** Subscribe to a raw socket's teardown. Called for every accepted
     *  WebSocket, before Hocuspocus authenticates it. */
    trackSocket(socket: ClosableSocket, request: object) {
      socket.once('close', () => onSocketClosed(request))
    },

    // Test-only introspection. Not part of the production API — production
    // callers shouldn't need to peek at internal counters.
    _snapshot() {
      return {
        connectionsPerIP: new Map(connectionsPerIP),
        connectionIPs: new Map(connectionIPs)
      }
    }
  }
}

// Per-IP cap is configurable via `SYNC_MAX_CONNECTIONS_PER_IP`. In dev
// you typically have many tabs / HMR reconnects from a single host
// machine — the production default of 20 trips constantly. Default to
// 200 in dev and 20 in prod via `NODE_ENV`. Override either way with
// the env var.
const envOverride = process.env.SYNC_MAX_CONNECTIONS_PER_IP
const parsedOverride = envOverride ? Number.parseInt(envOverride, 10) : Number.NaN
const isProd = process.env.NODE_ENV === 'production'
const defaultCap = isProd ? 20 : 200
const resolvedCap = Number.isFinite(parsedOverride) && parsedOverride > 0
  ? parsedOverride
  : defaultCap

export const rateLimiter = createRateLimiter({
  maxConnectionsPerIP: resolvedCap,
  trustedHops: parseTrustedProxyHops(process.env.TRUSTED_PROXY_HOPS)
})
