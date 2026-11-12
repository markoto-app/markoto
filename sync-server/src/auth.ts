import { verifyJwtWithRotation } from '../../shared/utils/security/secrets'
import type { SessionJwtPayload } from '../../shared/contracts/jwt'
import { captureMessage } from './sentry'
import { readDocNotBefore } from './doc-not-before'
import { syncEnv } from './env'
import { useLogger } from './logger'

const log = useLogger('auth')

// Hocuspocus `onAuthenticate` hook: runs on every new WS connection and
// MUST reject anything not carrying a valid, in-scope JWT. This is the
// sync-server's only line of defence; every other hook (onChange, onStore)
// trusts the context we return from here.
//
// Contract with the Nuxt app's token endpoint (`/api/docs/:id/token`):
//   - The app mints JWTs with { docId, userId, userName, readOnly } and
//     a 2h expiry using the shared JWT_SECRET.
//   - Password-protected and forbidden docs get `token: null`, which the
//     client never forwards; Hocuspocus rejects those connections via the
//     `if (!token)` path below.
//   - A token authorizes a connection only until its `exp`: the connection
//     is renewed in place or closed then (connection-expiry.ts), and a
//     document whose access became stricter refuses tokens issued before
//     the change (doc-not-before.ts).
//   - Rotation: the app still issues against the current secret; we accept
//     both current + previous during the rotation window. See
//     docs/operations/SECRETS-ROTATION.md and shared/utils/security/secrets.ts.

// The verifier extends the shared `SessionJwtPayload` with an OPTIONAL
// `scope` claim: the SessionJwtPayload contract intentionally omits
// `scope` (mint sites must never set it on session tokens), but we
// have to be able to OBSERVE it on incoming tokens to reject
// scope-narrowed JWTs replayed at the WS path. Defense in depth: even
// if a future mint site bug accidentally sets scope, this verifier
// rejects with 'Token scope mismatch' rather than letting it through.
export type DocJwtPayload = SessionJwtPayload & { scope?: string }

export interface AuthContext {
  readOnly: boolean
  userId: string | number
  userName: string | null
  /** When the token stops authorizing this connection (epoch ms). */
  tokenExpiresAt: number
}

export interface CreateAuthOptions {
  secret: string
  previousSecret?: string | null
  /**
   * The document's not-before cutoff (epoch seconds): tokens issued
   * earlier no longer open it, because its access became stricter after
   * they were minted. Absent in unit tests that don't exercise it.
   */
  notBeforeFor?: (docId: string) => Promise<number | null>
}

export type VerifiedDocToken = AuthContext

/**
 * Verify a session-shaped doc token for `documentName`. Used for the
 * connection handshake AND for every in-place token renewal, so both
 * paths apply exactly the same rules. Throws on any refusal.
 */
export function createTokenVerifier({ secret, previousSecret, notBeforeFor }: CreateAuthOptions) {
  return async function verifyDocToken(token: string | null, documentName: string): Promise<VerifiedDocToken> {
    // Always require a valid JWT, no anonymous bypass. Empty string and
    // null both count as missing.
    if (!token) {
      throw new Error('Authentication required')
    }

    let payload: DocJwtPayload & { iat?: unknown, exp?: unknown }
    try {
      payload = verifyJwtWithRotation<DocJwtPayload & { iat?: unknown, exp?: unknown }>(
        token,
        secret,
        previousSecret || undefined
      )
    } catch (e) {
      // Collapse every verify failure (expired, malformed, wrong signature,
      // 'alg: none' attempts: jsonwebtoken.verify with a string secret
      // defaults to HMAC algorithms only and rejects `alg: none`) into a
      // single error. Preserves the log line with the real cause for
      // operators without leaking which specific thing failed to callers.
      log.warn('invalid token', { docId: documentName, err: e })
      // `cause` stays server-side (logs/Sentry); callers only see the message.
      throw new Error('Invalid token', { cause: e })
    }

    // A token without an expiry would authorize a connection forever;
    // every mint site sets one, so its absence means a forged or
    // mis-minted token.
    if (typeof payload.exp !== 'number') {
      log.warn('token without exp', { docId: documentName })
      throw new Error('Invalid token')
    }

    // Scope check: a JWT minted for doc-A must never grant access to
    // doc-B. This is the critical cross-doc replay guard.
    if (payload.docId !== documentName) {
      throw new Error('Token scope mismatch')
    }

    // Reject scope-narrowed tokens. Hocuspocus connection requires a
    // session-shaped token (no `scope` claim). A token minted
    // with `scope: 'file-access'` (or any other future narrowing) was
    // issued for an HTTP endpoint and must not be promotable to a Y.js
    // connection. Without this check, a leaked render token could be
    // replayed against the WS to read the live doc state.
    if (typeof payload.scope === 'string' && payload.scope.length > 0) {
      log.warn('rejected scope-narrowed token', { docId: documentName, scope: payload.scope })
      // Operationally interesting: this branch fires when something
      // tries to escalate a narrow-scope token (e.g. a leaked render
      // token) into a Y.js connection. A spike here = active replay
      // attempt, alert-worthy.
      try {
        captureMessage('[auth] Rejected scope-narrowed token', {
          level: 'warning',
          tags: {
            component: 'sync-auth',
            event: 'scope_narrowed_rejected',
            scope: payload.scope
          }
        })
      } catch { /* telemetry must never throw */ }
      throw new Error('Token scope mismatch')
    }

    if (notBeforeFor) await assertIssuedAfterCutoff(payload.iat, documentName, notBeforeFor)

    // Safe-default read-only. If the claim is missing or any non-boolean,
    // treat the connection as read-only. A JWT must EXPLICITLY carry
    // `readOnly: false` (what the Nuxt mint path sends for writable
    // connections) to get write access. Guards against:
    //   - future mint changes that forget the field
    //   - hand-crafted JWTs from a leaked/rotated-out secret that omit
    //     the field to escalate from view-only to write
    return {
      readOnly: payload.readOnly !== false,
      userId: payload.userId,
      userName: payload.userName ?? null,
      tokenExpiresAt: payload.exp * 1000
    }
  }
}

async function assertIssuedAfterCutoff(
  iat: unknown,
  documentName: string,
  notBeforeFor: (docId: string) => Promise<number | null>
): Promise<void> {
  const notBefore = await notBeforeFor(documentName)
  const issuedAt = typeof iat === 'number' ? iat : 0
  if (notBefore !== null && issuedAt < notBefore) {
    throw new Error('Token revoked')
  }
}

/**
 * Build an `onAuthenticate` hook with explicit secrets. The production
 * instance reads from env (see the singleton export below); tests construct
 * their own without the env-var dance.
 */
export function createAuth(options: CreateAuthOptions) {
  const verifyDocToken = createTokenVerifier(options)
  return async function onAuthenticate({
    documentName,
    token,
    connectionConfig
  }: {
    documentName: string
    token: string | null
    // Hocuspocus passes the live connection config in the hook payload. We
    // MUST mutate `connectionConfig.readOnly` here, the object returned from
    // this hook is merged into request `context` only, which does NOT block
    // writes. The write gate in Hocuspocus reads `connection.readOnly`, seeded
    // from `connectionConfig.readOnly` (default `false`). Optional so unit
    // tests can call the hook with just `{ documentName, token }`.
    connectionConfig?: { readOnly: boolean }
  }): Promise<AuthContext> {
    const verified = await verifyDocToken(token, documentName)

    // Enforce read-only server-side. This is the load-bearing line: without
    // it, a read-only JWT still yields a writable connection because
    // Hocuspocus never reads our returned `readOnly` for write-blocking, it
    // only reads `connectionConfig.readOnly`, which defaults to `false`. A
    // malicious client (or a devtools bypass of the CM6 read-only compartment)
    // could otherwise send Y.js updates to any doc it can open a token for.
    if (connectionConfig) {
      connectionConfig.readOnly = verified.readOnly
    }

    return verified
  }
}

/**
 * Build the production auth singleton from env. Called once from index.ts
 * at boot so unit tests can import `createAuth` without tripping the env
 * guard. Validate-secrets already fail-fast at startup, but the explicit
 * check here guards against misuse from non-index callers.
 */
export function authFromEnv() {
  const secret = syncEnv().auth.jwtSecret
  if (!secret) {
    throw new Error('[auth] JWT_SECRET environment variable is required')
  }
  const options: CreateAuthOptions = {
    secret,
    previousSecret: syncEnv().auth.jwtSecretPrevious || undefined,
    notBeforeFor: readDocNotBefore
  }
  return {
    onAuthenticate: createAuth(options),
    verifyDocToken: createTokenVerifier(options)
  }
}
