import { createHash, randomBytes } from 'node:crypto'
import { nanoid } from 'nanoid'
import * as Sentry from '@sentry/nuxt'
import { findMcpTokenByHash, touchMcpTokenByHash } from '../../repos/access/mcpTokens'
import { insertMcpToken, upsertMcpSession } from '../../repos/mcpTokens'
import { proveSelf } from '../access/userProof'
import { useValkey } from '../platform/valkey'
import { MCP_SCOPES, type McpScope } from '~~/shared/api/account'
import type { UserScope } from '../../repos/proofs'

// MCP Personal Access Token primitives.
//
// Token shape: `mkt_<32-char-base32>`. The `mkt_` prefix makes leaked
// tokens spottable in logs / source repos (same trick GitHub uses with
// `ghp_`); the 32-char base32 body is 160 bits of entropy from
// crypto.randomBytes: well above any reasonable brute-force horizon.
//
// Storage: only the SHA-256 hash of the plaintext is persisted. The
// plaintext is shown ONCE at creation time and never reconstructed,
// users who lose it must mint a new one. Mirrors GitHub PATs.
//
// Verification: the verifier is on the hot path of every MCP tool call,
// so positive results are Valkey-cached for 60s keyed on the token hash.
// Cache misses fall through to the DB. Negative results are NOT cached
// a freshly issued token must light up immediately, and an attacker
// brute-forcing tokens shouldn't get free cache hits on their misses.
//
// MULTI-INSTANCE NOTE (read before scaling out): the verify cache is
// Valkey-backed, so the cache itself is shared across processes. But
// `invalidateMcpPatCache` is only called from the same process that
// served the revoke API request, the cache entry it deletes is the
// shared one in Valkey, so other processes ALSO see the invalidation
// (this is fine). What's NOT fine: process-local caching layers we
// might be tempted to add later (e.g. a 5s in-memory cache to
// short-circuit the Valkey GET). If you add one, also add a Valkey
// pub/sub channel to broadcast invalidations across processes,
// otherwise revoked tokens stay valid for the in-memory TTL on
// processes that didn't see the revoke. Single-instance today =
// no in-memory layer, no problem.

export const MCP_TOKEN_PREFIX = 'mkt_'
const MCP_TOKEN_BODY_BYTES = 20 // 20 bytes → 32 base32 chars

/** Per-user cap on active (non-revoked, non-expired) PATs. The
 *  cap is anti-abuse only, a real user almost never needs more than
 *  3-4 (one per device + one for scripts); the headroom is generous. */
export const MAX_PATS_PER_USER = 20

export { MCP_SCOPES, type McpScope }

export interface McpAuthContext {
  userId: number
  scopes: McpScope[]
  // The opaque token id (mkt_pat_…), useful for activity-log attribution
  // and per-token rate limiting. Distinct from the PK so URL surfaces
  // don't disclose row count.
  tokenId: string
}

// RFC 4648 base32 alphabet (no padding). Avoids 0/O/1/I confusion versus
// hex; case-insensitive when typed by humans, though we always emit
// uppercase.
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function encodeBase32(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += BASE32_ALPHABET[(value >> bits) & 0x1f]
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f]
  return out
}

export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex')
}

export function generateMcpToken(): { plaintext: string, hash: string } {
  const body = encodeBase32(randomBytes(MCP_TOKEN_BODY_BYTES))
  const plaintext = `${MCP_TOKEN_PREFIX}${body}`
  return { plaintext, hash: hashToken(plaintext) }
}

export interface IssueMcpTokenInput {
  /** The user the token acts as, issuing it for themselves. */
  self: UserScope
  name: string
  scopes: McpScope[]
  expiresAt?: Date | null
}

/**
 * Generate + persist a Personal Access Token. Single code path used by
 * the API endpoint (`POST /api/mcp/tokens`), the integration tests, and
 * any ad-hoc admin scripts. Returns the plaintext alongside the row id,
 * callers SHOULD surface the plaintext exactly once and never re-read
 * (we don't store it). Inserting through the same helper also keeps the
 * `mkt_pat_…` id format in lockstep.
 */
export async function issueMcpToken(input: IssueMcpTokenInput): Promise<{
  tokenId: string
  plaintext: string
  createdAt: Date
}> {
  const { plaintext, hash } = generateMcpToken()
  const tokenId = `mkt_pat_${nanoid(16)}`
  const row = await insertMcpToken(input.self, {
    tokenId,
    name: input.name,
    tokenHash: hash,
    scopes: input.scopes,
    expiresAt: input.expiresAt ?? null
  })
  if (!row) {
    // Drizzle .returning() always populates on a successful INSERT, this
    // branch is purely a TS-narrow + defense against future SQL drift.
    throw new Error('Token creation failed: INSERT returned no rows')
  }
  return { tokenId: row.tokenId, plaintext, createdAt: row.createdAt }
}

// Parse `Authorization: Bearer mkt_…`. Returns null on any shape mismatch
// (missing header, wrong scheme, wrong prefix, wrong length). The verifier
// returns null in all these cases so the MCP middleware stays soft,
// per toolkit guidance we never throw 401 from the MCP route.
export function extractMcpBearer(authHeader: string | undefined | null): string | null {
  if (!authHeader) return null
  const match = /^Bearer\s+(\S+)$/i.exec(authHeader)
  const token = match?.[1]
  if (!token) return null
  if (!token.startsWith(MCP_TOKEN_PREFIX)) return null
  // Body is 32 base32 chars; total length = prefix + 32.
  if (token.length !== MCP_TOKEN_PREFIX.length + 32) return null
  return token
}

const VERIFY_CACHE_NAMESPACE = 'mcp:pat:verify'
const VERIFY_CACHE_TTL_SECONDS = 60

interface CachedVerifyHit {
  userId: number
  scopes: McpScope[]
  tokenId: string
}

// Read-through cache. Positive hits only, misses are not cached so a
// brute-force attempt doesn't get free 401s and a fresh token lights up
// immediately. We also bump `last_used_at` here, throttled to once-per-
// minute via a separate Valkey key so the hot row doesn't churn.
export async function verifyMcpPat(plaintextOrHeader: string | null | undefined): Promise<McpAuthContext | null> {
  const token = plaintextOrHeader?.startsWith(MCP_TOKEN_PREFIX)
    ? plaintextOrHeader
    : extractMcpBearer(plaintextOrHeader)
  if (!token) return null

  const hash = hashToken(token)
  const cacheKey = `${VERIFY_CACHE_NAMESPACE}:${hash}`

  let cached: CachedVerifyHit | null = null
  try {
    const valkey = useValkey()
    const raw = await valkey.get(cacheKey)
    if (raw) cached = JSON.parse(raw) as CachedVerifyHit
  } catch {
    // Valkey unreachable: fall through to DB. Verification is
    // correctness-critical (we don't fail open here); the cache is a
    // performance amenity, not a security boundary.
  }

  if (cached) {
    void bumpLastUsed(hash)
    return cached
  }

  const row = await findMcpTokenByHash(hash)
  if (!row) return null
  if (row.revokedAt !== null) return null
  if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) return null

  const scopes = (row.scopes).filter((s): s is McpScope =>
    (MCP_SCOPES as readonly string[]).includes(s)
  )

  const ctx: McpAuthContext = {
    userId: row.userId,
    scopes,
    tokenId: row.tokenId
  }

  try {
    const valkey = useValkey()
    await valkey.set(cacheKey, JSON.stringify(ctx), 'EX', VERIFY_CACHE_TTL_SECONDS)
  } catch {
    // Same as above: cache write failure is non-fatal.
  }

  void bumpLastUsed(hash)
  return ctx
}

// Once-per-minute `last_used_at` bump. Without the throttle a chatty
// MCP client (which makes many tool calls per "thought") would generate
// one UPDATE per call against the same row.
const LAST_USED_THROTTLE_NAMESPACE = 'mcp:pat:bump'
const LAST_USED_THROTTLE_SECONDS = 60

async function bumpLastUsed(hash: string): Promise<void> {
  try {
    const valkey = useValkey()
    const key = `${LAST_USED_THROTTLE_NAMESPACE}:${hash}`
    const set = await valkey.set(key, '1', 'EX', LAST_USED_THROTTLE_SECONDS, 'NX')
    if (set !== 'OK') return // throttled
  } catch {
    return // Valkey down, skip the bump
  }
  try {
    await touchMcpTokenByHash(hash)
  } catch {
    // Best-effort; failure here is harmless.
  }
}

export function hasScope(scopes: McpScope[] | undefined, required: McpScope): boolean {
  return Array.isArray(scopes) && scopes.includes(required)
}

// Invalidate cache after revocation so the verifier doesn't keep accepting
// the token until TTL expiry. Single key, no scan, cheap.
export async function invalidateMcpPatCache(tokenHash: string): Promise<void> {
  try {
    const valkey = useValkey()
    await valkey.del(`${VERIFY_CACHE_NAMESPACE}:${tokenHash}`)
  } catch {
    // Cache will self-expire within 60s; non-fatal.
  }
}

export interface TouchMcpSessionInput {
  mcpSessionId: string
  userId: number
  tokenId: string | null
  clientName?: string | null
  userAgent?: string | null
}

const SESSION_TOUCH_THROTTLE_NAMESPACE = 'mcp:session:touch'
const SESSION_TOUCH_THROTTLE_SECONDS = 60

/**
 * Upsert an `mcp_sessions` row for the given session id. First call
 * (the middleware writes it on `initialize`, with `clientInfo.name`)
 * INSERTs; subsequent calls bump `last_active_at` (with `client_name`,
 * `user_agent` and `token_id` only set if they're currently null,
 * first writer wins).
 *
 * Throttled to once-per-minute per session via Valkey `SET NX EX`
 * (same pattern as `bumpLastUsed` for PATs). A chatty MCP client
 * issuing 30 tool calls per minute on the same session would
 * otherwise hammer this row 30×/min for no information gain.
 *
 * Fire-and-forget at call sites, best-effort like
 * `appendAuditEvent`. The user's tool call has already authenticated;
 * failing the call because the session-touch INSERT lost a race
 * would be confusing.
 *
 * Without this writer, `activity_log` rows tagged `mcp:{mcpSessionId}`
 * are dead pointers: the forensic question "who edited this doc via
 * MCP at 14:32" can't be answered. With it, the join chain (see
 * `mcpSessions` table comment in server/db/schema/mcp.ts) lights up.
 */
export async function touchMcpSession(input: TouchMcpSessionInput): Promise<void> {
  // Throttle FIRST-check: peek the Valkey key without claiming. If
  // already claimed (within the last 60s), skip the work entirely,
  // a chatty MCP client issuing 30 tool calls/min on the same session
  // would otherwise hammer this row 30×/min for no information gain.
  //
  // The throttle is claimed only AFTER a successful DB write: claiming
  // first would lock out retries for 60s after a failed write. Worst case under contention: two concurrent calls
  // both do the DB write before either claims, wasted work, not
  // correctness loss.
  const throttleKey = `${SESSION_TOUCH_THROTTLE_NAMESPACE}:${input.mcpSessionId}`
  try {
    const valkey = useValkey()
    const existing = await valkey.get(throttleKey)
    if (existing !== null) return // throttled
  } catch {
    // Valkey down: proceed to DB. Audit data is more important
    // than dedup of UPDATEs.
  }

  try {
    // The verified token's user (the middleware authenticated it).
    await upsertMcpSession(proveSelf(input.userId), {
      mcpSessionId: input.mcpSessionId,
      tokenId: input.tokenId,
      clientName: input.clientName ?? null,
      userAgent: input.userAgent ?? null
    })
  } catch (err) {
    // The whole point of mcp_sessions is forensic recoverability.
    // Silent loss defeats it. Capture for observability, the user's
    // tool call still proceeds (this helper is called fire-and-forget).
    Sentry.captureException(err, {
      tags: { component: 'mcp-sessions', event: 'touch_failed' },
      extra: { mcpSessionId: input.mcpSessionId, userId: input.userId }
    })
    return // don't set the throttle on failure, next call retries
  }

  // Success: NOW set the throttle so the next ~60s of calls skip
  // the DB write. If this Valkey write fails, the next call falls
  // through to a redundant DB write; harmless.
  try {
    const valkey = useValkey()
    await valkey.set(throttleKey, '1', 'EX', SESSION_TOUCH_THROTTLE_SECONDS)
  } catch {
    // Non-fatal: throttle is an optimization, not a correctness gate.
  }
}
