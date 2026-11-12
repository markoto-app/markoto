import jwt from 'jsonwebtoken'
import * as Sentry from '@sentry/nuxt'
import { tryAcquireSessionLock } from '../../platform/rateLimit'
import { normalizeLanguageCode } from '../dictateHelpers'
import { liveDictationTarget, resolveAiProviders, type LiveDictationTarget } from '../../aiProviders/resolve'
import { resolveBillingContext, type BillingContext } from '../../billing/billing'
import { getDocWorkspaceId } from '../../access/docProof'
import { system } from '../../../repos/proofs'
import type { DictateJwtPayload } from '~~/shared/contracts/jwt'
import { encodeServerFrame } from '~~/shared/contracts/dictateWs'
import { useEnv } from '~~/shared/env/load'
import { useLogger } from '../../platform/logger'
import { armHardCap, rejectPeer, resetIdleTimer, SESSION_HARD_CAP_MS, type DictatePeerContext, type PeerLike } from './peerContext'
import { openSttStream } from './upstreamSession'

const log = useLogger('dictate')

// The `auth` message of a dictation socket: verify the dictate JWT, take
// the one-session-per-user lock, resolve who pays (billing context, live
// dictation provider), open the upstream stream and tell the client it
// may send audio. Every refusal sends an `error` frame and closes.

type AuthClaims = Pick<DictateJwtPayload, 'userId' | 'docId'>

/** The token's user + document, or null after refusing the peer. */
function verifyDictateToken(peer: PeerLike, token: unknown): AuthClaims | null {
  const env = useEnv()
  const secret = env.auth.dictateJwtSecret || env.auth.jwtSecret
  if (!secret) {
    rejectPeer(peer, 'Server misconfigured', 1011, 'no jwt secret')
    return null
  }
  if (typeof token !== 'string' || !token) {
    rejectPeer(peer, 'Missing token', 4001, 'missing token')
    return null
  }
  // Type as Partial<DictateJwtPayload> — the verifier can't trust any
  // field is present until it's narrowed below. Using the shared
  // contract here pins the verify-shape to the mint-shape; a drift
  // (e.g. mint forgetting `scope`) becomes a compile error rather
  // than a runtime test failure with a misleading close-code.
  let payload: Partial<DictateJwtPayload>
  try {
    payload = jwt.verify(token, secret) as Partial<DictateJwtPayload>
  } catch {
    rejectPeer(peer, 'Invalid or expired token', 4001, 'invalid token')
    return null
  }
  if (payload.kind !== 'dictate' || typeof payload.userId !== 'number' || typeof payload.docId !== 'string') {
    rejectPeer(peer, 'Malformed token', 4001, 'malformed payload')
    return null
  }
  // Require explicit `scope: 'dictate'`. Pairs with the
  // sync-server's "any non-empty scope is rejected for WS auth" rule
  // (sync-server/src/auth.ts) — together they ensure dictate tokens
  // are usable HERE and only here. A token minted for any other
  // scope (`render`, `file-access`, future) cannot be replayed
  // against this WS, and a dictate token cannot be replayed against
  // Hocuspocus.
  if (payload.scope !== 'dictate') {
    rejectPeer(peer, 'Token scope mismatch', 4001, 'scope mismatch')
    return null
  }
  return { userId: payload.userId, docId: payload.docId }
}

export async function handleAuth(
  peer: PeerLike,
  ctx: DictatePeerContext,
  token: unknown,
  languageCode: unknown
): Promise<void> {
  const claims = verifyDictateToken(peer, token)
  if (!claims) return

  // Concurrent-session cap: one dictation session per user. Prevents a
  // user with multiple tabs open from silently burning their daily
  // budget 2-3× faster than expected (each chunk debits the shared
  // bucket, so concurrency amplifies spend without any UX signal).
  // TTL matches the session hard cap so a crashed worker's lock
  // self-expires.
  const lockAcquired = await tryAcquireSessionLock(
    'ai-dictate-active',
    String(claims.userId),
    SESSION_HARD_CAP_MS
  )
  if (!lockAcquired) {
    rejectPeer(peer, 'Another dictation session is already active', 4001, 'session already active')
    return
  }

  ctx.userId = claims.userId
  ctx.docId = claims.docId
  ctx.authed = true
  if (ctx.authTimer) {
    clearTimeout(ctx.authTimer)
    ctx.authTimer = undefined
  }

  const payer = await resolvePayer(peer, ctx, claims)
  if (!payer) return
  ctx.virtualKey = payer.billing.virtualKey
  ctx.voiceTickBilling = payer.target.platformBilled

  // Normalize language: accept either BCP-47 (`de-DE`) or the short
  // ISO 639-1 UI locale (`de`). Defaults to en-US if nothing usable
  // arrived — the upstream transcription API requires a valid
  // language code or rejects.
  const sttStream = openSttStream(peer, ctx, payer.target, normalizeLanguageCode(languageCode))
  if (!sttStream) return

  ctx.stt = sttStream
  peer.send(encodeServerFrame({ type: 'ready' }))

  armHardCap(peer, ctx)
  resetIdleTimer(peer, ctx)
}

/**
 * Who pays for this session: the billing context (the user's virtual key)
 * and the live dictation provider. Null after refusing the peer.
 */
async function resolvePayer(peer: PeerLike, ctx: DictatePeerContext, claims: AuthClaims): Promise<{ billing: BillingContext, target: LiveDictationTarget } | null> {
  // Resolve billing context to get the user's virtual-key token. If resolution fails (DB blip, missing user row) close the
  // session rather than silently fall through — billing is a
  // correctness surface, not a rate limit. The voice-tick orchestrator
  // hits LiteLLM with this key; if the user's $ budget is already 0,
  // the FIRST tick (fired on first audio chunk) returns 4xx and the
  // WS closes cleanly with `budget_exhausted` code 1011.
  // Resolve the doc's workspace first: it tags the spend AND decides
  // which plan pays (a Team / Business workspace's member key). Best-effort — a doc that
  // disappeared mid-handshake just means we tag with no workspace
  // dimension, which is harmless (the call still bills correctly).
  try {
    // The signed dictation token proves write access to this document.
    ctx.workspaceId = (await getDocWorkspaceId(claims.docId)) ?? null
  } catch {
    ctx.workspaceId = null
  }

  let billing: BillingContext
  try {
    billing = await resolveBillingContext(claims.userId, ctx.workspaceId)
  } catch (e) {
    log.error('billing resolve failed', { err: e })
    Sentry.captureException(e, {
      tags: { component: 'dictate', event: 'billing_resolve_failed', userId: String(claims.userId) }
    })
    rejectPeer(peer, 'Could not resolve billing; please retry.', 1011, 'billing resolve failed')
    return null
  }
  // BYOK: live dictation is Voxtral Realtime (Mistral-only, direct WS).
  // Available with the user's own Mistral transcription key (their
  // account pays — no LiteLLM ticks) or with a platform-alias instance
  // default + the operator's MISTRAL_API_KEY (ticks bill the user's
  // LiteLLM budget, as before BYOK). The mic is hidden otherwise; this
  // is the server-side backstop.
  let target: LiveDictationTarget | null
  try {
    // The dictation token was signed for this user by the token route
    // (session + write access), so the socket acts for them.
    const dictating = system('live-dictation').actingFor(claims.userId)
    target = liveDictationTarget((await resolveAiProviders(dictating, billing.plan)).transcription)
  } catch (e) {
    log.error('provider resolve failed', { err: e })
    target = null
  }
  if (!target) {
    rejectPeer(peer, 'Live dictation needs a Mistral transcription key. Add one in Settings → AI provider.', 4004, 'no dictation provider')
    return null
  }
  return { billing, target }
}
