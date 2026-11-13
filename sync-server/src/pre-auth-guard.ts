// Memory cap for messages a WebSocket sends BEFORE a document connection
// is authenticated.
//
// Hocuspocus (ClientConnection) queues every message for a document name
// until that document's Auth frame has been verified and the document has
// loaded, then replays the queue. Nothing bounds that queue: a client
// could open sockets (they cost no rate-limit slot until they send an Auth
// frame), never authenticate, and stream frames of up to
// SYNC_MAX_MESSAGE_BYTES each into server memory. Messages for a document
// whose authentication FAILED are also queued, forever, for as long as the
// socket stays open.
//
// This guard mirrors that queue from a second `message` listener on the
// raw socket (registered after Hocuspocus's, so it sees every frame
// Hocuspocus queued) and closes the socket when:
//   - a document's queued messages have no Auth frame after
//     SYNC_AUTH_TIMEOUT_MS            → close 4408 `auth-timeout`
//     (an ordinary disconnect: the editor reconnects),
//   - the socket's queued bytes exceed SYNC_MAX_PREAUTH_BYTES, or all
//     sockets' together exceed SYNC_MAX_PREAUTH_TOTAL_BYTES
//                                     → close 4413 `update-too-large`
//     (the editor shows "changes were not saved" and stops reconnecting,
//     resending the same backlog would be refused again).
// Closing the socket drops Hocuspocus's queue with it. The socket is
// terminated shortly after the close frame, so a peer that never answers
// the closing handshake can't keep it (and its queue) alive.
//
// Accounting. Each queued frame costs its length plus a fixed overhead
// for the per-message bookkeeping, so a flood of tiny frames is bounded
// too. A document's bytes are released when its connection is established
// (`documentEstablished`, Hocuspocus `connected` hook, the queue has been
// replayed by then) and come back into play if that document connection
// closes while the socket stays open (`documentClosed`, `onDisconnect`):
// Hocuspocus starts a fresh queue for it. Hocuspocus re-emits the queued
// frames on replay; they are the same objects, so a WeakSet keeps them
// from being counted twice.
//
// Legitimate clients stay far below the caps: the provider sends Auth,
// sync step 1 and one awareness update, a few hundred bytes, plus, after
// being offline, the edits it buffered meanwhile (bounded by the document
// size limit), and the Auth frame follows within milliseconds.

import { SYNC_CLOSE_CODES, SYNC_CLOSE_REASONS, SYNC_AUTH_TIMEOUT_REASON } from '../../shared/contracts/syncClose'
import { MESSAGE_TYPE, readFrameHeader } from './frame'
import type { SyncEnv } from '../../shared/env/registry'
import { sync } from '../../shared/env/vars/sync'

export const DEFAULT_MAX_PREAUTH_BYTES = sync.vars.maxPreauthBytes.default
export const DEFAULT_MAX_PREAUTH_TOTAL_BYTES = sync.vars.maxPreauthTotalBytes.default
export const DEFAULT_AUTH_TIMEOUT_MS = sync.vars.authTimeoutMs.default
/** Bookkeeping cost charged per queued frame on top of its length. */
export const PREAUTH_MESSAGE_OVERHEAD_BYTES = 128
/** Grace period between the close frame and a hard terminate. */
const TERMINATE_AFTER_MS = 1000

export interface PreAuthLimits {
  /** Queued bytes per socket. */
  maxBytesPerSocket: number
  /** Queued bytes across all sockets of this process. */
  maxBytesTotal: number
  /** Time a document may queue messages without having sent its Auth frame. */
  authTimeoutMs: number
}

export function parsePreAuthLimits(env: SyncEnv): PreAuthLimits {
  return {
    maxBytesPerSocket: env.sync.maxPreauthBytes,
    maxBytesTotal: env.sync.maxPreauthTotalBytes,
    authTimeoutMs: env.sync.authTimeoutMs
  }
}

/** The slice of a `ws` WebSocket the guard uses. */
export interface GuardedSocket {
  on(event: 'message', listener: (data: unknown) => void): unknown
  once(event: 'close', listener: () => void): unknown
  close(code: number, reason: string): void
  terminate(): void
}

export type PreAuthRejection = 'auth-timeout' | 'too-large'

export interface PreAuthGuardOptions {
  /** Called once per rejected socket (logging / telemetry). */
  onReject?: (reason: PreAuthRejection, detail: string) => void
}

interface PendingDocument {
  bytes: number
  authSeen: boolean
  timer: ReturnType<typeof setTimeout> | null
}

interface SocketState {
  socket: GuardedSocket
  done: boolean
  bytes: number
  pending: Map<string, PendingDocument>
  established: Set<string>
  counted: WeakSet<object>
  socketId: string | null
}

export function createPreAuthGuard(limits: PreAuthLimits, options: PreAuthGuardOptions = {}) {
  let totalBytes = 0
  const byRequest = new WeakMap<object, SocketState>()
  const bySocketId = new Map<string, SocketState>()

  function release(state: SocketState, name: string): void {
    const entry = state.pending.get(name)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    state.bytes -= entry.bytes
    totalBytes -= entry.bytes
    state.pending.delete(name)
  }

  function reject(state: SocketState, reason: PreAuthRejection, detail: string): void {
    if (state.done) return
    state.done = true
    for (const entry of state.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = null
    }
    options.onReject?.(reason, detail)
    try {
      if (reason === 'auth-timeout') {
        state.socket.close(SYNC_CLOSE_CODES.authTimeout, SYNC_AUTH_TIMEOUT_REASON)
      } else {
        state.socket.close(SYNC_CLOSE_CODES.payloadTooLarge, SYNC_CLOSE_REASONS.updateTooLarge)
      }
    } catch {
      // Already closing: terminate below still applies.
    }
    const kill = setTimeout(() => {
      try {
        state.socket.terminate()
      } catch {
        // Already gone.
      }
    }, TERMINATE_AFTER_MS)
    kill.unref?.()
  }

  function onMessage(state: SocketState, data: unknown): void {
    if (state.done || !(data instanceof Uint8Array)) return
    if (state.counted.has(data)) return // Hocuspocus replaying its queue
    state.counted.add(data)

    let header: { documentName: string, type: number }
    try {
      header = readFrameHeader(data)
    } catch {
      return // Hocuspocus closes the socket on an undecodable frame itself.
    }
    const name = header.documentName
    if (state.established.has(name)) return

    let entry = state.pending.get(name)
    if (!entry) {
      entry = { bytes: 0, authSeen: false, timer: null }
      state.pending.set(name, entry)
    }
    if (header.type === MESSAGE_TYPE.auth) {
      entry.authSeen = true
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = null
    } else if (!entry.authSeen && !entry.timer) {
      const pendingEntry = entry
      const timer = setTimeout(() => {
        pendingEntry.timer = null
        if (!pendingEntry.authSeen && state.pending.get(name) === pendingEntry) {
          reject(state, 'auth-timeout', `no auth frame within ${limits.authTimeoutMs} ms`)
        }
      }, limits.authTimeoutMs)
      timer.unref?.()
      entry.timer = timer
    }

    const cost = data.byteLength + PREAUTH_MESSAGE_OVERHEAD_BYTES
    entry.bytes += cost
    state.bytes += cost
    totalBytes += cost
    if (state.bytes > limits.maxBytesPerSocket) {
      reject(state, 'too-large', `${state.bytes} bytes queued on one socket`)
    } else if (totalBytes > limits.maxBytesTotal) {
      reject(state, 'too-large', `${totalBytes} bytes queued across all sockets`)
    }
  }

  function onClose(state: SocketState): void {
    state.done = true
    for (const name of [...state.pending.keys()]) release(state, name)
    if (state.socketId !== null) bySocketId.delete(state.socketId)
  }

  return {
    /** Watch a freshly accepted socket. Call AFTER Hocuspocus registered its own listener. */
    trackSocket(socket: GuardedSocket, request: object): void {
      const state: SocketState = {
        socket,
        done: false,
        bytes: 0,
        pending: new Map(),
        established: new Set(),
        counted: new WeakSet(),
        socketId: null
      }
      byRequest.set(request, state)
      socket.on('message', data => onMessage(state, data))
      socket.once('close', () => onClose(state))
    },

    /** The document connection is up and its queue replayed (Hocuspocus `connected`). */
    documentEstablished(request: object, socketId: string, documentName: string): void {
      const state = byRequest.get(request)
      if (!state || state.done) return
      state.socketId = socketId
      bySocketId.set(socketId, state)
      state.established.add(documentName)
      release(state, documentName)
    },

    /** A document connection closed while its socket may stay open (Hocuspocus `onDisconnect`). */
    documentClosed(socketId: string, documentName: string): void {
      bySocketId.get(socketId)?.established.delete(documentName)
    },

    /** Test-only introspection. */
    _snapshot() {
      return { totalBytes }
    }
  }
}
