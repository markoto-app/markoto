import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { at, first } from '../helpers/assert'
import { useValkey } from '../../server/utils/platform/valkey'
import {
  BINDING_IDLE_MS,
  MAX_SESSIONS_PER_USER,
  ValkeyMcpSessionBindings
} from '../../server/utils/mcp/mcpSessionBinding'

// MCP session ↔ token bindings against the REAL Valkey test container: they survive a restart and are shared
// by every app instance. Each test uses fresh random user ids / session ids, so no cleanup is needed (keys expire).

function uid(): number {
  return 1_000_000 + randomBytes(3).readUIntBE(0, 3)
}

function sid(label: string): string {
  return `${label}-${randomBytes(6).toString('hex')}`
}

describe('ValkeyMcpSessionBindings', () => {
  it('binds a session to its token; another token (same user or not) is refused', async () => {
    const b = new ValkeyMcpSessionBindings()
    const user = uid()
    const s = sid('s')
    expect(await b.bind(s, 'tok-full', user)).toBe(true)
    expect(await b.check(s, 'tok-full')).toBe('ok')
    expect(await b.check(s, 'tok-ro')).toBe('token-mismatch')
    expect(await b.check(sid('unknown'), 'tok-full')).toBe('unknown')
  })

  it('survives a restart: a fresh instance (no process state) still enforces the binding', async () => {
    const user = uid()
    const s = sid('restart')
    expect(await new ValkeyMcpSessionBindings().bind(s, 'tok-a', user)).toBe(true)
    // "Restart": nothing carried over but Valkey.
    const afterRestart = new ValkeyMcpSessionBindings()
    expect(await afterRestart.check(s, 'tok-a')).toBe('ok')
    expect(await afterRestart.check(s, 'tok-b')).toBe('token-mismatch')
    expect(await afterRestart.countForUser(user)).toBe(1)
  })

  it('set-if-absent: an id that is already bound is never re-pointed to another token', async () => {
    const b = new ValkeyMcpSessionBindings()
    const s = sid('nx')
    expect(await b.bind(s, 'tok-a', uid())).toBe(true)
    expect(await b.bind(s, 'tok-b', uid())).toBe(false)
    expect(await b.check(s, 'tok-a')).toBe('ok')
    expect(await b.check(s, 'tok-b')).toBe('token-mismatch')
  })

  it('keeps at most MAX_SESSIONS_PER_USER per user, dropping the least recently used', async () => {
    let now = Date.now()
    const b = new ValkeyMcpSessionBindings(useValkey, () => now)
    const user = uid()
    const ids = Array.from({ length: MAX_SESSIONS_PER_USER }, (_, i) => sid(`lru${i}`))
    for (const id of ids) {
      now += 1
      await b.bind(id, 't1', user)
    }
    now += 1
    expect(await b.check(first(ids), 't1')).toBe('ok') // ids[0] is now the most recently used
    now += 1
    const fresh = sid('new')
    await b.bind(fresh, 't1', user)
    expect(await b.countForUser(user)).toBe(MAX_SESSIONS_PER_USER)
    expect(await b.check(at(ids, 1), 't1')).toBe('unknown') // the least recently used one went
    expect(await b.check(first(ids), 't1')).toBe('ok')
    expect(await b.check(fresh, 't1')).toBe('ok')
    // Other users are unaffected.
    const other = sid('bob')
    await b.bind(other, 't2', uid())
    expect(await b.check(other, 't2')).toBe('ok')
  })

  it('the cap holds under a concurrent burst of binds (one atomic script each)', async () => {
    const b = new ValkeyMcpSessionBindings()
    const user = uid()
    const ids = Array.from({ length: 60 }, (_, i) => sid(`burst${i}`))
    await Promise.all(ids.map(id => b.bind(id, 't1', user)))
    expect(await b.countForUser(user)).toBe(MAX_SESSIONS_PER_USER)
    const alive = await Promise.all(ids.map(id => b.check(id, 't1')))
    expect(alive.filter(r => r === 'ok')).toHaveLength(MAX_SESSIONS_PER_USER)
  })

  it('bindings expire after the idle lifetime; a successful check renews it', async () => {
    const valkey = useValkey()
    const b = new ValkeyMcpSessionBindings()
    const user = uid()
    const s = sid('ttl')
    await b.bind(s, 't1', user)
    const ttl = await valkey.pttl(`mcp:binding:${s}`)
    expect(ttl).toBeGreaterThan(BINDING_IDLE_MS - 5_000)
    expect(ttl).toBeLessThanOrEqual(BINDING_IDLE_MS)
    await valkey.pexpire(`mcp:binding:${s}`, 10_000)
    expect(await b.check(s, 't1')).toBe('ok')
    expect(await valkey.pttl(`mcp:binding:${s}`)).toBeGreaterThan(BINDING_IDLE_MS - 5_000)
    // Expired → unknown, and the per-user count forgets it once its score is old.
    await valkey.pexpire(`mcp:binding:${s}`, 1)
    await new Promise(r => setTimeout(r, 20))
    expect(await b.check(s, 't1')).toBe('unknown')
    const later = Date.now() + BINDING_IDLE_MS + 1
    expect(await new ValkeyMcpSessionBindings(useValkey, () => later).countForUser(user)).toBe(0)
  })

  it('a failed (wrong-token) check does not renew the binding', async () => {
    const valkey = useValkey()
    const b = new ValkeyMcpSessionBindings()
    const s = sid('norenew')
    await b.bind(s, 't1', uid())
    await valkey.pexpire(`mcp:binding:${s}`, 10_000)
    expect(await b.check(s, 't2')).toBe('token-mismatch')
    expect(await valkey.pttl(`mcp:binding:${s}`)).toBeLessThanOrEqual(10_000)
  })

  it('revoking a token drops exactly its bindings and frees the slots', async () => {
    const b = new ValkeyMcpSessionBindings()
    const user = uid()
    const a1 = sid('a1')
    const a2 = sid('a2')
    const keep = sid('keep')
    await b.bind(a1, 'tok-a', user)
    await b.bind(a2, 'tok-a', user)
    await b.bind(keep, 'tok-b', user)
    expect(await b.countForUser(user)).toBe(3)
    expect(await b.releaseToken('tok-a', user)).toBe(2)
    expect(await b.check(a1, 'tok-a')).toBe('unknown')
    expect(await b.check(a2, 'tok-a')).toBe('unknown')
    expect(await b.check(keep, 'tok-b')).toBe('ok')
    expect(await b.countForUser(user)).toBe(1)
  })

  it('release drops one binding', async () => {
    const b = new ValkeyMcpSessionBindings()
    const user = uid()
    const s = sid('rel')
    await b.bind(s, 't1', user)
    await b.release(s)
    expect(await b.check(s, 't1')).toBe('unknown')
    expect(await b.countForUser(user)).toBe(0)
  })
})
