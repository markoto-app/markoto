import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { anonClient } from '../setup/client'
import { createDoc, createUser } from '../setup/fixtures'
import { TEST_INTERNAL_SECRET } from '../setup/env'

// POST /api/internal/activity — cross-service boundary. Called by the
// sync-server to persist Y.js edit/join/leave events. Auth is the shared
// INTERNAL_API_SECRET header, not a user session.
//
// Regression focus: the secret check is the ONLY thing standing between
// the outside world and writing arbitrary rows into activity_log. Every
// negative path (missing header, wrong value, wrong mechanism) needs to
// 401 — silently accepting would let anyone spoof attribution.

async function countActivity(docId: string): Promise<number> {
  const db = testDb()
  const r = await db.query<{ c: string }>(
    'SELECT COUNT(*) AS c FROM activity_log WHERE doc_id = $1',
    [docId]
  )
  return Number(r.rows[0]?.c ?? 0)
}

describe('POST /api/internal/activity', () => {
  beforeEach(async () => {
    await resetDb()
  })

  describe('auth', () => {
    it('rejects request with no secret header (401)', async () => {
      const doc = await createDoc({ accessMode: 'open-edit' })
      const res = await anonClient().post('/api/internal/activity', {
        docId: doc.docId,
        action: 'edit'
      })
      expect(res.status).toBe(401)
    })

    it('rejects wrong secret (401)', async () => {
      const doc = await createDoc({ accessMode: 'open-edit' })
      const res = await anonClient().post('/api/internal/activity',
        { docId: doc.docId, action: 'edit' },
        { headers: { 'x-internal-secret': 'not-the-secret' } }
      )
      expect(res.status).toBe(401)
    })

    it('does not confuse a user session for an internal secret', async () => {
      // Session cookies should never grant internal-secret-gated writes.
      const user = await createUser()
      const doc = await createDoc({ accessMode: 'open-edit' })
      const loggedIn = await anonClient() // reused as cookie jar
      await loggedIn.post('/api/_test/login', { userId: user.id, name: user.name })
      const res = await loggedIn.post('/api/internal/activity', {
        docId: doc.docId,
        action: 'edit'
      })
      expect(res.status).toBe(401)
    })
  })

  describe('validation', () => {
    it('rejects missing docId (400)', async () => {
      const res = await anonClient().post('/api/internal/activity',
        { action: 'edit' },
        { headers: { 'x-internal-secret': TEST_INTERNAL_SECRET } }
      )
      expect(res.status).toBe(400)
    })

    it('rejects invalid action (400)', async () => {
      const doc = await createDoc({ accessMode: 'open-edit' })
      const res = await anonClient().post('/api/internal/activity',
        { docId: doc.docId, action: 'hack' },
        { headers: { 'x-internal-secret': TEST_INTERNAL_SECRET } }
      )
      expect(res.status).toBe(400)
    })
  })

  describe('happy path', () => {
    it('logs an edit entry for a known doc', async () => {
      const doc = await createDoc({ accessMode: 'open-edit' })
      const res = await anonClient().post('/api/internal/activity',
        { docId: doc.docId, action: 'edit', userName: 'Alice', wordCount: 42 },
        { headers: { 'x-internal-secret': TEST_INTERNAL_SECRET } }
      )
      expect(res.status).toBe(200)
      const body = await res.json() as { logged: boolean }
      expect(body.logged).toBe(true)
      expect(await countActivity(doc.docId)).toBe(1)
    })

    it('silently skips (logged=false) for an unknown doc', async () => {
      // Anon / direct-URL docs that never hit the DB shouldn't pollute
      // activity_log with phantom entries. 200 + logged:false is fine —
      // the sync-server doesn't need to distinguish.
      const res = await anonClient().post('/api/internal/activity',
        { docId: 'nonexistent', action: 'edit', userName: 'Eve' },
        { headers: { 'x-internal-secret': TEST_INTERNAL_SECRET } }
      )
      expect(res.status).toBe(200)
      const body = await res.json() as { logged: boolean }
      expect(body.logged).toBe(false)
    })

    it('bumps lastActive on edit action', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      // Park lastActive in the past.
      const db = testDb()
      await db.query(
        `UPDATE documents SET last_active = now() - interval '1 day' WHERE doc_id = $1`,
        [doc.docId]
      )
      const before = (await db.query<{ la: Date }>(
        'SELECT last_active AS la FROM documents WHERE doc_id = $1',
        [doc.docId]
      )).rows[0].la
      await anonClient().post('/api/internal/activity',
        { docId: doc.docId, action: 'edit', userName: 'Alice' },
        { headers: { 'x-internal-secret': TEST_INTERNAL_SECRET } }
      )
      const after = (await db.query<{ la: Date }>(
        'SELECT last_active AS la FROM documents WHERE doc_id = $1',
        [doc.docId]
      )).rows[0].la
      expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime())
    })

    it('does NOT bump lastActive for join/leave (passive viewers shouldn\'t keep docs alive)', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const db = testDb()
      await db.query(
        `UPDATE documents SET last_active = now() - interval '1 day' WHERE doc_id = $1`,
        [doc.docId]
      )
      const before = (await db.query<{ la: Date }>(
        'SELECT last_active AS la FROM documents WHERE doc_id = $1',
        [doc.docId]
      )).rows[0].la
      await anonClient().post('/api/internal/activity',
        { docId: doc.docId, action: 'join', userName: 'Eve' },
        { headers: { 'x-internal-secret': TEST_INTERNAL_SECRET } }
      )
      const after = (await db.query<{ la: Date }>(
        'SELECT last_active AS la FROM documents WHERE doc_id = $1',
        [doc.docId]
      )).rows[0].la
      expect(new Date(after).getTime()).toBe(new Date(before).getTime())
    })
  })
})
