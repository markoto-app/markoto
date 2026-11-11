import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { resetDb, testDb } from '../integration/setup/db'
import { createUser } from '../integration/setup/fixtures'
import { mcpPersonalTokens } from '../../server/db/schema'
import { useDatabase } from '../../server/utils/platform/database'
import { useValkey } from '../../server/utils/platform/valkey'
import {
  issueMcpToken,
  verifyMcpPat,
  invalidateMcpPatCache,
  hashToken
} from '../../server/utils/mcp/mcpAuth'

// DB-backed tests for the Personal Access Token verifier. The pure-
// function bits (token format, header parsing, hash stability, scope
// membership) are pinned in `tests/unit/mcpAuth.test.ts`; this file
// covers the round-trip + cache + lifecycle that requires a real DB
// and a real Valkey.
//
// Hot path: every MCP request hits `verifyMcpPat`. Bugs here surface
// as "tool calls silently start returning empty / failing auth even
// though the token is correct" — exactly the regression class that
// pure-function tests can't catch.

describe('issueMcpToken', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('persists a row with the issued hash + tokenId + scopes', async () => {
    const user = await createUser()
    const issued = await issueMcpToken({
      userId: user.id,
      name: 'test',
      scopes: ['documents:read', 'documents:write']
    })

    expect(issued.tokenId).toMatch(/^mkt_pat_/)
    expect(issued.plaintext).toMatch(/^mkt_[A-Z2-7]{32}$/)
    expect(issued.createdAt).toBeInstanceOf(Date)

    const db = useDatabase()
    const rows = await db.select().from(mcpPersonalTokens).where(eq(mcpPersonalTokens.tokenId, issued.tokenId))
    expect(rows.length).toBe(1)
    expect(rows[0]!.userId).toBe(user.id)
    expect(rows[0]!.name).toBe('test')
    expect(rows[0]!.scopes).toEqual(['documents:read', 'documents:write'])
    expect(rows[0]!.tokenHash).toBe(hashToken(issued.plaintext))
    // Plaintext is NEVER persisted. Cross-check the column doesn't
    // contain it (paranoia regression guard).
    expect(rows[0]!.tokenHash).not.toBe(issued.plaintext)
  })

  it('issued tokens are unique across calls', async () => {
    const user = await createUser()
    const a = await issueMcpToken({ userId: user.id, name: 'a', scopes: ['documents:read'] })
    const b = await issueMcpToken({ userId: user.id, name: 'b', scopes: ['documents:read'] })
    expect(a.plaintext).not.toBe(b.plaintext)
    expect(a.tokenId).not.toBe(b.tokenId)
  })

  it('accepts an explicit expiresAt', async () => {
    const user = await createUser()
    const exp = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const issued = await issueMcpToken({
      userId: user.id, name: 'exp', scopes: ['documents:read'], expiresAt: exp
    })
    const db = useDatabase()
    const rows = await db.select().from(mcpPersonalTokens).where(eq(mcpPersonalTokens.tokenId, issued.tokenId))
    expect(rows[0]!.expiresAt?.getTime()).toBe(exp.getTime())
  })
})

describe('verifyMcpPat', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('verifies a freshly issued plaintext to {userId, scopes, tokenId}', async () => {
    const user = await createUser()
    const issued = await issueMcpToken({
      userId: user.id, name: 't', scopes: ['documents:read', 'web:fetch']
    })
    // Clear the cache so the first call hits the DB. (issueMcpToken
    // doesn't warm the cache, but be explicit so the test isn't
    // accidentally testing the cache path.)
    await invalidateMcpPatCache(hashToken(issued.plaintext))

    const ctx = await verifyMcpPat(issued.plaintext)
    expect(ctx).not.toBeNull()
    expect(ctx!.userId).toBe(user.id)
    expect(ctx!.scopes).toEqual(['documents:read', 'web:fetch'])
    expect(ctx!.tokenId).toBe(issued.tokenId)
  })

  it('accepts both raw plaintext and "Bearer <token>" header forms', async () => {
    const user = await createUser()
    const issued = await issueMcpToken({
      userId: user.id, name: 't', scopes: ['documents:read']
    })
    const direct = await verifyMcpPat(issued.plaintext)
    const header = await verifyMcpPat(`Bearer ${issued.plaintext}`)
    expect(direct?.userId).toBe(user.id)
    expect(header?.userId).toBe(user.id)
  })

  it('returns null for an unknown plaintext', async () => {
    expect(await verifyMcpPat('mkt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBeNull()
  })

  it('returns null for a missing / malformed header', async () => {
    expect(await verifyMcpPat(null)).toBeNull()
    expect(await verifyMcpPat(undefined)).toBeNull()
    expect(await verifyMcpPat('')).toBeNull()
    expect(await verifyMcpPat('Bearer not-a-token')).toBeNull()
  })

  it('returns null for a revoked token (after cache invalidation)', async () => {
    const user = await createUser()
    const issued = await issueMcpToken({
      userId: user.id, name: 't', scopes: ['documents:read']
    })
    // Warm cache.
    expect(await verifyMcpPat(issued.plaintext)).not.toBeNull()

    // Revoke directly (mirrors what the DELETE endpoint does).
    const db = useDatabase()
    await db.update(mcpPersonalTokens)
      .set({ revokedAt: new Date() })
      .where(eq(mcpPersonalTokens.tokenId, issued.tokenId))
    await invalidateMcpPatCache(hashToken(issued.plaintext))

    expect(await verifyMcpPat(issued.plaintext)).toBeNull()
  })

  it('returns null for an expired token (expiresAt in the past)', async () => {
    const user = await createUser()
    const past = new Date(Date.now() - 60_000)
    const issued = await issueMcpToken({
      userId: user.id, name: 't', scopes: ['documents:read'], expiresAt: past
    })
    expect(await verifyMcpPat(issued.plaintext)).toBeNull()
  })

  it('returns the token even when expiresAt is in the future', async () => {
    const user = await createUser()
    const future = new Date(Date.now() + 60 * 60_000)
    const issued = await issueMcpToken({
      userId: user.id, name: 't', scopes: ['documents:read'], expiresAt: future
    })
    expect(await verifyMcpPat(issued.plaintext)).not.toBeNull()
  })

  it('filters out unknown scope values stored in the row (forward-compat narrowing)', async () => {
    // If a future version writes a scope value we don't recognise (or
    // someone hand-edits the row), `verifyMcpPat` must strip it from
    // the returned context — never escalate to "all scopes granted".
    const user = await createUser()
    const issued = await issueMcpToken({
      userId: user.id, name: 't', scopes: ['documents:read']
    })
    const db = useDatabase()
    await db.update(mcpPersonalTokens)
      .set({ scopes: ['documents:read', 'fake:future:scope'] })
      .where(eq(mcpPersonalTokens.tokenId, issued.tokenId))
    await invalidateMcpPatCache(hashToken(issued.plaintext))

    const ctx = await verifyMcpPat(issued.plaintext)
    expect(ctx?.scopes).toEqual(['documents:read'])
  })

  it('the verifier cache hits on the second call within TTL (no DB query)', async () => {
    const user = await createUser()
    const issued = await issueMcpToken({
      userId: user.id, name: 't', scopes: ['documents:read']
    })
    // First call populates cache.
    await verifyMcpPat(issued.plaintext)

    // Now delete the row entirely. If the second call goes to the DB
    // it would return null; if it hits the cache it returns the warm
    // context. We use this as the cache-hit oracle.
    const db = useDatabase()
    await db.delete(mcpPersonalTokens).where(eq(mcpPersonalTokens.tokenId, issued.tokenId))

    const ctx = await verifyMcpPat(issued.plaintext)
    expect(ctx).not.toBeNull()
    expect(ctx!.userId).toBe(user.id)
  })

  it('invalidateMcpPatCache forces the next call to re-read from the DB', async () => {
    const user = await createUser()
    const issued = await issueMcpToken({
      userId: user.id, name: 't', scopes: ['documents:read']
    })
    await verifyMcpPat(issued.plaintext) // warm cache

    // Mutate the row's scopes AFTER warming.
    const db = useDatabase()
    await db.update(mcpPersonalTokens)
      .set({ scopes: ['documents:write'] })
      .where(eq(mcpPersonalTokens.tokenId, issued.tokenId))

    // Without invalidation, the cache still serves the old scopes.
    const cached = await verifyMcpPat(issued.plaintext)
    expect(cached?.scopes).toEqual(['documents:read'])

    // After invalidation, the verifier re-reads.
    await invalidateMcpPatCache(hashToken(issued.plaintext))
    const fresh = await verifyMcpPat(issued.plaintext)
    expect(fresh?.scopes).toEqual(['documents:write'])
  })

  it('bumps lastUsedAt on a successful verify (throttled, async)', async () => {
    const user = await createUser()
    const issued = await issueMcpToken({
      userId: user.id, name: 't', scopes: ['documents:read']
    })
    // Clear any throttle key from previous tests to ensure the first
    // call's bump fires.
    const valkey = useValkey()
    await valkey.del(`mcp:pat:bump:${hashToken(issued.plaintext)}`)

    await verifyMcpPat(issued.plaintext)

    // The bump is fire-and-forget (void bumpLastUsed) — give it a
    // beat to round-trip.
    await new Promise(r => setTimeout(r, 250))

    const db = useDatabase()
    const rows = await db.select({ lastUsedAt: mcpPersonalTokens.lastUsedAt })
      .from(mcpPersonalTokens)
      .where(eq(mcpPersonalTokens.tokenId, issued.tokenId))
    expect(rows[0]!.lastUsedAt).toBeInstanceOf(Date)
  })
})

describe('verifyMcpPat — cascade on user deletion', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns null after the owning user is deleted (FK cascade)', async () => {
    const user = await createUser()
    const issued = await issueMcpToken({
      userId: user.id, name: 't', scopes: ['documents:read']
    })

    // Delete the user — FK on `mcp_personal_tokens.user_id` is `ON
    // DELETE cascade` so the token row goes away with them.
    const tdb = testDb()
    await tdb.query('DELETE FROM users WHERE id = $1', [user.id])

    // Invalidate the cache so we don't get a stale hit from any prior
    // warming.
    await invalidateMcpPatCache(hashToken(issued.plaintext))

    expect(await verifyMcpPat(issued.plaintext)).toBeNull()
  })
})
