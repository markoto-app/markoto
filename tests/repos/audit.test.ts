import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import {
  appendAuditEvent,
  getAuditEventsByScope,
  getAuditEventsByActor,
  truncateIp
} from '../../server/repos/audit'
import { createUser } from '../integration/setup/fixtures'

async function auditCount(): Promise<number> {
  const db = testDb()
  const r = await db.query<{ c: string }>('SELECT COUNT(*) AS c FROM audit_log')
  return Number(r.rows[0].c)
}

describe('truncateIp', () => {
  it('truncates IPv4 to /24 (drops last octet)', () => {
    expect(truncateIp('192.168.1.42')).toBe('192.168.1.0')
    expect(truncateIp('10.0.0.1')).toBe('10.0.0.0')
    expect(truncateIp('255.255.255.255')).toBe('255.255.255.0')
  })

  it('truncates IPv6 to /48 (keeps first 3 hextets, RFC 5952 canonical)', () => {
    expect(truncateIp('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe('2001:db8:85a3::')
    expect(truncateIp('2001:db8:85a3::1')).toBe('2001:db8:85a3::')
    expect(truncateIp('fe80::1')).toBe('fe80:0:0::')
  })

  it('returns null on null / empty / unparseable input', () => {
    expect(truncateIp(null)).toBeNull()
    expect(truncateIp('')).toBeNull()
    expect(truncateIp('   ')).toBeNull()
    expect(truncateIp('not-an-ip')).toBeNull()
    expect(truncateIp('192.168.1.999')).toBeNull()
  })
})

describe('appendAuditEvent', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('inserts a row that read-by-scope returns', async () => {
    const u = await createUser()
    await appendAuditEvent({
      actorUserId: u.id,
      actorIp: '192.168.1.42',
      scope: 'doc',
      scopeId: 'doc-A',
      action: 'doc.deleted',
      before: { title: 'Old', accessMode: 'private' },
      after: null,
      metadata: { reason: 'user_initiated' }
    })
    expect(await auditCount()).toBe(1)
    const rows = await getAuditEventsByScope('doc', 'doc-A')
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('doc.deleted')
    expect(rows[0].actorUserId).toBe(u.id)
    // IP stored truncated.
    expect(rows[0].actorIp).toBe('192.168.1.0')
    expect(rows[0].before).toEqual({ title: 'Old', accessMode: 'private' })
    expect(rows[0].metadata).toEqual({ reason: 'user_initiated' })
  })

  it('read-by-actor returns the row for that actor', async () => {
    const u = await createUser()
    await appendAuditEvent({
      actorUserId: u.id,
      actorIp: null,
      scope: 'workspace',
      scopeId: 'ws-1',
      action: 'workspace.member_removed'
    })
    const rows = await getAuditEventsByActor(u.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].scope).toBe('workspace')
  })

  it('tuple-key isolation: scope=doc scopeId=A query never returns doc=B rows', async () => {
    const u = await createUser()
    await appendAuditEvent({ actorUserId: u.id, actorIp: null, scope: 'doc', scopeId: 'doc-A', action: 'doc.deleted' })
    await appendAuditEvent({ actorUserId: u.id, actorIp: null, scope: 'doc', scopeId: 'doc-B', action: 'doc.deleted' })
    const rowsA = await getAuditEventsByScope('doc', 'doc-A')
    expect(rowsA).toHaveLength(1)
    expect(rowsA[0].scopeId).toBe('doc-A')
  })

  it('accepts null actorUserId (system actions)', async () => {
    await appendAuditEvent({
      actorUserId: null,
      actorIp: null,
      scope: 'system',
      scopeId: null,
      action: 'doc.deleted',
      metadata: { reason: 'inactive_sweep' }
    })
    expect(await auditCount()).toBe(1)
  })

  it('accepts null actorIp', async () => {
    const u = await createUser()
    await appendAuditEvent({ actorUserId: u.id, actorIp: null, scope: 'doc', scopeId: 'd', action: 'doc.deleted' })
    const rows = await getAuditEventsByScope('doc', 'd')
    expect(rows[0].actorIp).toBeNull()
  })

  it('truncates IPv4 actorIp on insert', async () => {
    await appendAuditEvent({ actorUserId: null, actorIp: '203.0.113.42', scope: 'doc', scopeId: 'd', action: 'doc.deleted' })
    const rows = await getAuditEventsByScope('doc', 'd')
    expect(rows[0].actorIp).toBe('203.0.113.0')
  })

  it('truncates IPv6 actorIp on insert', async () => {
    await appendAuditEvent({
      actorUserId: null,
      actorIp: '2001:0db8:85a3:0000:0000:8a2e:0370:7334',
      scope: 'doc', scopeId: 'd', action: 'doc.deleted'
    })
    const rows = await getAuditEventsByScope('doc', 'd')
    expect(rows[0].actorIp).toBe('2001:db8:85a3::')
  })
})

describe('getAuditEventsByScope', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns rows ordered by ts desc (most-recent-first)', async () => {
    const u = await createUser()
    await appendAuditEvent({ actorUserId: u.id, actorIp: null, scope: 'doc', scopeId: 'd', action: 'doc.deleted', metadata: { n: 1 } })
    await new Promise(r => setTimeout(r, 5))
    await appendAuditEvent({ actorUserId: u.id, actorIp: null, scope: 'doc', scopeId: 'd', action: 'doc.deleted', metadata: { n: 2 } })
    await new Promise(r => setTimeout(r, 5))
    await appendAuditEvent({ actorUserId: u.id, actorIp: null, scope: 'doc', scopeId: 'd', action: 'doc.deleted', metadata: { n: 3 } })
    const rows = await getAuditEventsByScope('doc', 'd')
    expect(rows.map(r => (r.metadata as { n: number }).n)).toEqual([3, 2, 1])
  })

  it('paginates via beforeId', async () => {
    const u = await createUser()
    // 5 rows
    for (let i = 0; i < 5; i++) {
      await appendAuditEvent({
        actorUserId: u.id, actorIp: null, scope: 'doc', scopeId: 'd',
        action: 'doc.deleted', metadata: { n: i }
      })
    }
    const page1 = await getAuditEventsByScope('doc', 'd', { limit: 2 })
    expect(page1).toHaveLength(2)
    const page2 = await getAuditEventsByScope('doc', 'd', { limit: 2, beforeId: page1[page1.length - 1].id })
    expect(page2).toHaveLength(2)
    // No id overlap between pages.
    const ids1 = page1.map(r => r.id)
    const ids2 = page2.map(r => r.id)
    expect(ids1.some(id => ids2.includes(id))).toBe(false)
  })

  it('respects the limit argument', async () => {
    const u = await createUser()
    for (let i = 0; i < 5; i++) {
      await appendAuditEvent({ actorUserId: u.id, actorIp: null, scope: 'doc', scopeId: 'd', action: 'doc.deleted' })
    }
    const rows = await getAuditEventsByScope('doc', 'd', { limit: 3 })
    expect(rows).toHaveLength(3)
  })
})

describe('getAuditEventsByActor', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('isolates per-actor: actor A query never returns actor B rows', async () => {
    const a = await createUser()
    const b = await createUser()
    await appendAuditEvent({ actorUserId: a.id, actorIp: null, scope: 'doc', scopeId: 'd', action: 'doc.deleted' })
    await appendAuditEvent({ actorUserId: b.id, actorIp: null, scope: 'doc', scopeId: 'd', action: 'doc.deleted' })
    const aRows = await getAuditEventsByActor(a.id)
    expect(aRows).toHaveLength(1)
    expect(aRows[0].actorUserId).toBe(a.id)
  })

  it('orders by ts desc and paginates via beforeId', async () => {
    const u = await createUser()
    for (let i = 0; i < 4; i++) {
      await appendAuditEvent({ actorUserId: u.id, actorIp: null, scope: 'doc', scopeId: 'd', action: 'doc.deleted', metadata: { n: i } })
    }
    const page1 = await getAuditEventsByActor(u.id, { limit: 2 })
    expect(page1.map(r => (r.metadata as { n: number }).n)).toEqual([3, 2])
    const page2 = await getAuditEventsByActor(u.id, { limit: 2, beforeId: page1[page1.length - 1].id })
    expect(page2.map(r => (r.metadata as { n: number }).n)).toEqual([1, 0])
  })
})
