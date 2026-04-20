import { verifyJwtWithRotation } from '../../shared/utils/secrets'

// Hocuspocus `onAuthenticate` hook — runs on every new WS connection and
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
//   - Rotation: the app still issues against the current secret; we accept
//     both current + previous during the rotation window. See
//     docs/SECRETS-ROTATION.md and shared/utils/secrets.ts.

// What the token endpoint actually signs. `userId` may be either a number
// (logged-in user) or the literal 'anonymous' string (unauthenticated but
// with a doc-scoped JWT, e.g. password-verified). readOnly is optional in
// the TS shape so we can assert the safe-default behaviour explicitly in
// the body — a JWT that omits the claim falls through to read-only.
export interface DocJwtPayload {
  docId: string
  userId: string | number
  userName?: string | null
  readOnly?: boolean
}

export interface AuthContext {
  readOnly: boolean
  userId: string | number
  userName: string | null
}

export interface CreateAuthOptions {
  secret: string
  previousSecret?: string | null
}

/**
 * Build an `onAuthenticate` hook with explicit secrets. The production
 * instance reads from env (see the singleton export below); tests construct
 * their own without the env-var dance.
 */
export function createAuth({ secret, previousSecret }: CreateAuthOptions) {
  return async function onAuthenticate({
    documentName,
    token
  }: { documentName: string, token: string | null }): Promise<AuthContext> {
    // Always require a valid JWT — no anonymous bypass. Empty string and
    // null both count as missing.
    if (!token) {
      throw new Error('Authentication required')
    }

    let payload: DocJwtPayload
    try {
      payload = verifyJwtWithRotation<DocJwtPayload>(
        token,
        secret,
        previousSecret || undefined
      )
    } catch (e) {
      // Collapse every verify failure (expired, malformed, wrong signature,
      // 'alg: none' attempts — jsonwebtoken.verify with a string secret
      // defaults to HMAC algorithms only and rejects `alg: none`) into a
      // single error. Preserves the log line with the real cause for
      // operators without leaking which specific thing failed to callers.
      console.warn(`[auth] Invalid token for ${documentName}:`, e instanceof Error ? e.message : e)
      throw new Error('Invalid token')
    }

    // Scope check — a JWT minted for doc-A must never grant access to
    // doc-B. This is the critical cross-doc replay guard.
    if (payload.docId !== documentName) {
      throw new Error('Token scope mismatch')
    }

    // Safe-default read-only. If the claim is missing or any non-boolean,
    // treat the connection as read-only. A JWT must EXPLICITLY carry
    // `readOnly: false` (what the Nuxt mint path sends for writable
    // connections) to get write access. Guards against:
    //   - future mint changes that forget the field
    //   - hand-crafted JWTs from a leaked/rotated-out secret that omit
    //     the field to escalate from view-only to write
    const readOnly = payload.readOnly !== false

    return {
      readOnly,
      userId: payload.userId,
      userName: payload.userName ?? null
    }
  }
}

/**
 * Build the production auth singleton from env. Called once from index.ts
 * at boot so unit tests can import `createAuth` without tripping the env
 * guard. Validate-secrets already fail-fast at startup, but the explicit
 * check here guards against misuse from non-index callers.
 */
export function authFromEnv() {
  const secret = process.env.JWT_SECRET
  if (!secret) {
    throw new Error('[auth] JWT_SECRET environment variable is required')
  }
  return {
    onAuthenticate: createAuth({
      secret,
      previousSecret: process.env.JWT_SECRET_PREVIOUS || undefined
    })
  }
}
