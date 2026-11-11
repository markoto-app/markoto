import { SYNC_CLOSE_CODES, SYNC_REAUTH_REASON } from '../../shared/contracts/syncClose'
import { SYNTHETIC_USER_ID_PREFIXES } from '../../shared/contracts/jwt'
import type { VerifiedDocToken } from './auth'

// A doc token is checked once, when a connection authenticates. Without
// the code below an open connection would outlive its token, a share
// link's expiry and any later tightening of the document's access.
//
//   - Every connection is tracked with its token's expiry. Shortly before
//     it, the server asks the client for a fresh token (Hocuspocus' token
//     sync); the editor fetches one from the app's token endpoint, which
//     re-checks access, and the connection carries on uninterrupted.
//   - A connection whose token is not renewed by its expiry (plus a small
//     grace for clock skew) is closed with the re-authenticate reason.
//   - The app can close every connection of a document the same way when
//     its access becomes stricter (`/internal/reauth-document`).
//
// Pure in-memory logic, no Postgres/Valkey imports, so the unit tests can
// drive it with fake connections and timers.

/** How long before expiry the server asks for a fresh token. Covers the client's round trip to the token endpoint. */
export const TOKEN_RENEW_LEAD_MS = 45_000
/** Clock-skew allowance between the app that stamps `exp` and this server. */
export const TOKEN_EXPIRY_GRACE_MS = 5_000

/** The parts of a Hocuspocus `Connection` this module touches. */
export interface ReauthConnection {
  context?: { userId?: string | number | null, tokenExpiresAt?: number } | null
  readOnly?: boolean
  requestToken?(): void
  close?(event?: { code: number, reason: string }): void
  webSocket?: { close(code?: number, reason?: string): void }
}

/**
 * Close a connection so the client re-authenticates. Returns false when
 * the document-level close threw (the caller's count stays honest). The document
 * connection goes first: from then on nothing the client sends is
 * applied, even while the socket's closing handshake runs. Then the
 * socket — the provider reconnects on a socket close (not on a
 * document-level close message), fetching a token on the way. Our
 * clients open one socket per document, so no other document is cut.
 */
export function closeForReauth(conn: ReauthConnection): boolean {
  const event = { code: SYNC_CLOSE_CODES.reauthenticate, reason: SYNC_REAUTH_REASON }
  let closed = true
  try {
    conn.close?.(event)
  } catch (e) {
    closed = false
    console.warn('[reauth] document close failed:', e instanceof Error ? e.message : e)
  }
  try {
    conn.webSocket?.close(event.code, event.reason)
  } catch (e) {
    console.warn('[reauth] socket close failed:', e instanceof Error ? e.message : e)
  }
  return closed
}

export interface ExpiryClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const systemClock: ExpiryClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

interface Tracked {
  timer: unknown
  /** Last time this connection was asked for a token. */
  requestedAt: number | null
}

export interface ConnectionExpiryOptions {
  renewLeadMs?: number
  graceMs?: number
  clock?: ExpiryClock
  /** Observability hook, called right before an expired connection is closed. */
  onExpired?: (conn: ReauthConnection) => void
}

export function createConnectionExpiry(options: ConnectionExpiryOptions = {}) {
  const renewLeadMs = options.renewLeadMs ?? TOKEN_RENEW_LEAD_MS
  const graceMs = options.graceMs ?? TOKEN_EXPIRY_GRACE_MS
  const clock = options.clock ?? systemClock
  // One timer per open connection; removed on close (`untrack`), so the
  // map never holds more entries than there are live connections.
  const tracked = new Map<ReauthConnection, Tracked>()

  function setTimer(conn: ReauthConnection, entry: Tracked, fn: () => void, delayMs: number) {
    if (entry.timer !== null) clock.clearTimeout(entry.timer)
    entry.timer = clock.setTimeout(fn, Math.max(0, delayMs))
  }

  function scheduleClose(conn: ReauthConnection, entry: Tracked, expiresAt: number) {
    setTimer(conn, entry, () => {
      tracked.delete(conn)
      options.onExpired?.(conn)
      closeForReauth(conn)
    }, expiresAt + graceMs - clock.now())
  }

  function requestRenewal(conn: ReauthConnection, entry: Tracked, expiresAt: number) {
    entry.requestedAt = clock.now()
    try {
      conn.requestToken?.()
    } catch (e) {
      console.warn('[reauth] token request failed:', e instanceof Error ? e.message : e)
    }
    scheduleClose(conn, entry, expiresAt)
  }

  /**
   * Start (or restart, after a renewal) the expiry schedule of `conn`.
   * A connection is asked for a fresh token at most once per lead window:
   * a short-lived token (a share link that expires in a minute) gets one
   * request and then closes at its expiry instead of re-asking in a loop.
   */
  function track(conn: ReauthConnection, expiresAt: number): void {
    let entry = tracked.get(conn)
    if (!entry) {
      entry = { timer: null, requestedAt: null }
      tracked.set(conn, entry)
    }
    const now = clock.now()
    const renewAt = expiresAt - renewLeadMs
    const recentlyAsked = entry.requestedAt !== null && now - entry.requestedAt < renewLeadMs
    if (renewAt > now) {
      const e = entry
      setTimer(conn, e, () => requestRenewal(conn, e, expiresAt), renewAt - now)
    } else if (recentlyAsked) {
      scheduleClose(conn, entry, expiresAt)
    } else {
      requestRenewal(conn, entry, expiresAt)
    }
  }

  function untrack(conn: ReauthConnection): void {
    const entry = tracked.get(conn)
    if (!entry) return
    if (entry.timer !== null) clock.clearTimeout(entry.timer)
    tracked.delete(conn)
  }

  /**
   * Handle a token the client sent in answer to a token request. A token
   * that fails verification, or that names a different principal or
   * write access than the connection was opened with, closes the
   * connection: the client reconnects with the token it now holds, and a
   * changed access level takes effect through the normal handshake.
   * Never throws (a throwing hook would make Hocuspocus close the
   * connection with a reason the client doesn't treat as re-auth).
   */
  async function renew(
    conn: ReauthConnection,
    token: string,
    documentName: string,
    verify: (token: string, documentName: string) => Promise<VerifiedDocToken>
  ): Promise<void> {
    let verified: VerifiedDocToken
    try {
      verified = await verify(token, documentName)
    } catch {
      untrack(conn)
      closeForReauth(conn)
      return
    }
    const ctx = conn.context
    const samePrincipal = ctx?.userId != null && String(ctx.userId) === String(verified.userId)
    if (!samePrincipal || verified.readOnly !== (conn.readOnly ?? true)) {
      untrack(conn)
      closeForReauth(conn)
      return
    }
    if (ctx) ctx.tokenExpiresAt = verified.tokenExpiresAt
    // A connection closed while the token was being verified has already
    // been untracked; don't resurrect its timer.
    if (tracked.has(conn)) track(conn, verified.tokenExpiresAt)
  }

  return { track, untrack, renew, size: () => tracked.size }
}

/** Server-side clients of the app itself (AI, MCP, restore, comments). */
export function isSyntheticPrincipal(userId: unknown): boolean {
  if (typeof userId !== 'string') return false
  return SYNTHETIC_USER_ID_PREFIXES.some(prefix => userId.startsWith(prefix))
}

export interface ReauthDocument {
  getConnections?(): ReauthConnection[]
}

/**
 * Close every connection of a loaded document so each client
 * re-authenticates against the document's current access. The app's own
 * server-side clients are left alone: their access was checked by the app
 * right before they connected, they are short-lived, and cutting one off
 * would fail an AI edit or a restore halfway.
 */
export function performReauthDocument(doc: ReauthDocument | undefined): number {
  if (!doc) return 0
  let closed = 0
  // Copy first: closing removes the connection from the live set.
  for (const conn of [...(doc.getConnections?.() ?? [])]) {
    if (isSyntheticPrincipal(conn.context?.userId)) continue
    if (closeForReauth(conn)) closed++
  }
  return closed
}
