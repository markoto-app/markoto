import type Redis from 'ioredis'
import { useValkey } from '../platform/valkey'
import { MINUTE_MS } from '~~/shared/config/units'

// Which personal access token created each MCP session.
//
// The MCP toolkit keeps its sessions (one McpServer + transport each) in
// the memory of the process that answered `initialize`; its tool list is
// fixed at that moment from the token's scopes. Without a binding, ANY
// valid token presented together with somebody's session id would be
// served by that session — a read-only token could reach write tools
// registered for a full-scope one. So:
//
//   - a session is only created after the token verified (middleware),
//   - its id is bound here to that token — set-if-absent, so an id can
//     never be re-pointed to another token,
//   - every later request must present the SAME token (and the token is
//     re-verified per request, so revocation still bites immediately),
//   - per user, at most `MAX_SESSIONS_PER_USER` bound sessions: binding
//     one more drops that user's least recently used binding (its next
//     request gets "Session not found" and the client re-initializes).
//     Clients that re-initialize often are never locked out; how fast a
//     user can create sessions at all is rate-limited in `mcpGate.ts`,
//   - revoking a token drops its bindings (`releaseToken`).
//
// Storage is Valkey, so bindings survive an app restart and are shared
// by every instance (a request that lands on another instance is judged
// by the same table):
//
//   mcp:binding:{sessionId}       "{userId}:{tokenId}", PX = idle lifetime
//   mcp:binding-user:{userId}     ZSET sessionId → last use (ms), same TTL
//
// Every operation is ONE Lua script, so concurrent binds of one user
// can't overshoot the cap and a check can't race a drop. Entries idle
// longer than the toolkit's session lifetime expire on their own.
//
// Failure polarity: a Valkey error during `check` refuses the request
// (the gate answers "Session not found" — fail closed; this is an
// authorization control, unlike the fail-open rate limits). A failed
// `bind` leaves the new session unbound, so its next request is refused
// and the client re-initializes.

export const MAX_SESSIONS_PER_USER = 20
/** Slightly longer than the toolkit's 30-min idle session lifetime. */
export const BINDING_IDLE_MS = 35 * MINUTE_MS

export type BindingCheck = 'ok' | 'unknown' | 'token-mismatch'

export interface McpSessionBindings {
  /** Bind `sessionId` to the token. False when the id is already bound (never re-pointed). */
  bind(sessionId: string, tokenId: string, userId: number): Promise<boolean>
  /** Verify `tokenId` is the token that created `sessionId`; refreshes the idle timer on success. */
  check(sessionId: string, tokenId: string): Promise<BindingCheck>
  /** Live sessions held by `userId`. */
  countForUser(userId: number): Promise<number>
  release(sessionId: string): Promise<void>
  /** Drop every binding of `tokenId` (token revoked). Resolves to the number dropped. */
  releaseToken(tokenId: string, userId: number): Promise<number>
}

const BINDING_PREFIX = 'mcp:binding:'
const USER_PREFIX = 'mcp:binding-user:'

const bindingKey = (sessionId: string) => `${BINDING_PREFIX}${sessionId}`
const userKey = (userId: number) => `${USER_PREFIX}${userId}`

// KEYS[1] binding key, KEYS[2] user zset
// ARGV: sessionId, value, now, idleMs, max, bindingPrefix
const BIND_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
local now = tonumber(ARGV[3])
local idle = tonumber(ARGV[4])
local max = tonumber(ARGV[5])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - idle)
local n = redis.call('ZCARD', KEYS[2])
if n >= max then
  local victims = redis.call('ZRANGE', KEYS[2], 0, n - max)
  for _, sid in ipairs(victims) do
    redis.call('DEL', ARGV[6] .. sid)
    redis.call('ZREM', KEYS[2], sid)
  end
end
redis.call('SET', KEYS[1], ARGV[2], 'PX', idle)
redis.call('ZADD', KEYS[2], now, ARGV[1])
redis.call('PEXPIRE', KEYS[2], idle)
return 1
`

// KEYS[1] binding key
// ARGV: sessionId, tokenId, now, idleMs, userPrefix
const CHECK_SCRIPT = `
local v = redis.call('GET', KEYS[1])
if not v then return 'unknown' end
local sep = string.find(v, ':', 1, true)
if not sep then return 'unknown' end
local uid = string.sub(v, 1, sep - 1)
local tok = string.sub(v, sep + 1)
if tok ~= ARGV[2] then return 'token-mismatch' end
local idle = tonumber(ARGV[4])
redis.call('PEXPIRE', KEYS[1], idle)
local zkey = ARGV[5] .. uid
redis.call('ZADD', zkey, tonumber(ARGV[3]), ARGV[1])
redis.call('PEXPIRE', zkey, idle)
return 'ok'
`

// KEYS[1] user zset
// ARGV: now, idleMs
const COUNT_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]) - tonumber(ARGV[2]))
return redis.call('ZCARD', KEYS[1])
`

// KEYS[1] binding key
// ARGV: sessionId, userPrefix
const RELEASE_SCRIPT = `
local v = redis.call('GET', KEYS[1])
if not v then return 0 end
local sep = string.find(v, ':', 1, true)
redis.call('DEL', KEYS[1])
if sep then redis.call('ZREM', ARGV[2] .. string.sub(v, 1, sep - 1), ARGV[1]) end
return 1
`

// KEYS[1] user zset
// ARGV: tokenId, userId, bindingPrefix
const RELEASE_TOKEN_SCRIPT = `
local dropped = 0
local expected = ARGV[2] .. ':' .. ARGV[1]
for _, sid in ipairs(redis.call('ZRANGE', KEYS[1], 0, -1)) do
  local v = redis.call('GET', ARGV[3] .. sid)
  if not v then
    redis.call('ZREM', KEYS[1], sid)
  elseif v == expected then
    redis.call('DEL', ARGV[3] .. sid)
    redis.call('ZREM', KEYS[1], sid)
    dropped = dropped + 1
  end
end
return dropped
`

function toCheck(v: unknown): BindingCheck {
  return v === 'ok' || v === 'token-mismatch' ? v : 'unknown'
}

export class ValkeyMcpSessionBindings implements McpSessionBindings {
  constructor(
    private readonly redis: () => Redis = useValkey,
    private readonly now: () => number = Date.now
  ) {}

  async bind(sessionId: string, tokenId: string, userId: number): Promise<boolean> {
    const res = await this.redis().eval(
      BIND_SCRIPT, 2, bindingKey(sessionId), userKey(userId),
      sessionId, `${userId}:${tokenId}`, this.now(), BINDING_IDLE_MS, MAX_SESSIONS_PER_USER, BINDING_PREFIX
    )
    return res === 1
  }

  async check(sessionId: string, tokenId: string): Promise<BindingCheck> {
    const res = await this.redis().eval(
      CHECK_SCRIPT, 1, bindingKey(sessionId),
      sessionId, tokenId, this.now(), BINDING_IDLE_MS, USER_PREFIX
    )
    return toCheck(res)
  }

  async countForUser(userId: number): Promise<number> {
    const res = await this.redis().eval(COUNT_SCRIPT, 1, userKey(userId), this.now(), BINDING_IDLE_MS)
    return typeof res === 'number' ? res : 0
  }

  async release(sessionId: string): Promise<void> {
    await this.redis().eval(RELEASE_SCRIPT, 1, bindingKey(sessionId), sessionId, USER_PREFIX)
  }

  async releaseToken(tokenId: string, userId: number): Promise<number> {
    const res = await this.redis().eval(RELEASE_TOKEN_SCRIPT, 1, userKey(userId), tokenId, userId, BINDING_PREFIX)
    return typeof res === 'number' ? res : 0
  }
}

let shared: McpSessionBindings | null = null

/** Binding table used by the `/mcp` middleware and token revocation. */
export function useMcpSessionBindings(): McpSessionBindings {
  shared ??= new ValkeyMcpSessionBindings()
  return shared
}
