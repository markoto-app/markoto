import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import {
  appendActivity,
  pruneActivity,
  listRecentActivity,
  deleteActivityForDoc
} from '../../server/repos/activity'
import { createUser, createDoc as seedDoc } from '../integration/setup/fixtures'

async function activityCount(docId: string): Promise<number> {
  const db = testDb()
  const r = await db.query<{ c: string }>(
    'SELECT COUNT(*) AS c FROM activity_log WHERE doc_id = $1', [docId]
  )
  return Number(r.rows[0].c)
}

describe('appendActivity', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('inserts a row with the provided fields', async () => {
    const u = await createUser()
    const doc = await seedDoc({ ownerId: u.id })
    await appendActivity({
      docId: doc.docId, userName: 'Alice', action: 'edit',
      wordCount: 10, linesAdded: 2, linesRemoved: 1
    })
    expect(await activityCount(doc.docId)).toBe(1)
  })

  it('clamps linesAdded/linesRemoved at 0', async () => {
    // Activity logger may pass negative values from a buggy diff.
    // We should never store negatives — the display layer treats them
    // as "unknown" otherwise.
    const u = await createUser()
    const doc = await seedDoc({ ownerId: u.id })
    await appendActivity({
      docId: doc.docId, userName: null, action: 'edit',
      linesAdded: -5, linesRemoved: -3
    })
    const db = testDb()
    const r = await db.query<{ lines_added: number | null, lines_removed: number | null }>(
      'SELECT lines_added, lines_removed FROM activity_log WHERE doc_id = $1',
      [doc.docId]
    )
    expect(r.rows[0].lines_added).toBe(0)
    expect(r.rows[0].lines_removed).toBe(0)
  })

  it('rounds fractional wordCount', async () => {
    const u = await createUser()
    const doc = await seedDoc({ ownerId: u.id })
    await appendActivity({ docId: doc.docId, userName: null, action: 'edit', wordCount: 12.7 })
    const db = testDb()
    const r = await db.query<{ word_count: number | null }>(
      'SELECT word_count FROM activity_log WHERE doc_id = $1', [doc.docId]
    )
    expect(r.rows[0].word_count).toBe(13)
  })

  it('accepts null userName (anonymous attribution)', async () => {
    const u = await createUser()
    const doc = await seedDoc({ ownerId: u.id })
    await appendActivity({ docId: doc.docId, userName: null, action: 'join' })
    expect(await activityCount(doc.docId)).toBe(1)
  })
})

describe('pruneActivity', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('no-op when count is ≤ cap (500)', async () => {
    const u = await createUser()
    const doc = await seedDoc({ ownerId: u.id })
    for (let i = 0; i < 10; i++) {
      await appendActivity({ docId: doc.docId, userName: null, action: 'edit' })
    }
    await pruneActivity(doc.docId)
    expect(await activityCount(doc.docId)).toBe(10)
  })

  it('drops oldest rows above the 500-row cap', async () => {
    // Use batch SQL insert — calling appendActivity 501 times serially
    // would work but makes the test slow. Direct INSERT is fine since
    // the test is about pruneActivity, not appendActivity shape.
    const u = await createUser()
    const doc = await seedDoc({ ownerId: u.id })
    const db = testDb()
    // 501 rows, timestamp ascending so id order matches insert order
    const values = Array.from({ length: 501 }, (_, i) => `('${doc.docId}', 'edit', 'u', ${i})`).join(',')
    await db.query(
      `INSERT INTO activity_log (doc_id, action, user_name, word_count) VALUES ${values}`
    )
    expect(await activityCount(doc.docId)).toBe(501)
    await pruneActivity(doc.docId)
    expect(await activityCount(doc.docId)).toBe(500)
    // The oldest row (word_count=0) should be gone; word_count=500
    // (the newest) should remain.
    const min = await db.query<{ w: number }>(
      'SELECT MIN(word_count) AS w FROM activity_log WHERE doc_id = $1', [doc.docId]
    )
    expect(Number(min.rows[0].w)).toBe(1)
  })

  it('after 600 inserts, only the most-recent 500 remain', async () => {
    // Verifies the rewritten subquery shape (MIN over top-N) keeps the
    // newest 500 rows. word_count is used as a monotonic insertion-order
    // marker so we can assert the boundary.
    const u = await createUser()
    const doc = await seedDoc({ ownerId: u.id })
    const db = testDb()
    const values = Array.from({ length: 600 }, (_, i) => `('${doc.docId}', 'edit', 'u', ${i})`).join(',')
    await db.query(
      `INSERT INTO activity_log (doc_id, action, user_name, word_count) VALUES ${values}`
    )
    expect(await activityCount(doc.docId)).toBe(600)
    await pruneActivity(doc.docId)
    expect(await activityCount(doc.docId)).toBe(500)
    // Oldest 100 rows (word_count 0..99) gone; newest (word_count 100..599) kept.
    const range = await db.query<{ mn: number, mx: number }>(
      'SELECT MIN(word_count) AS mn, MAX(word_count) AS mx FROM activity_log WHERE doc_id = $1',
      [doc.docId]
    )
    expect(Number(range.rows[0].mn)).toBe(100)
    expect(Number(range.rows[0].mx)).toBe(599)
  })

  it('pruning doc A does not touch doc B (isolation)', async () => {
    // Explicit isolation cover: a 600-row doc A prune leaves a 600-row
    // doc B completely untouched. Mirrors the original isolation test
    // but exercises the new subquery shape with both docs over-cap.
    const u = await createUser()
    const docA = await seedDoc({ ownerId: u.id })
    const docB = await seedDoc({ ownerId: u.id })
    const db = testDb()
    const valsA = Array.from({ length: 600 }, (_, i) => `('${docA.docId}', 'edit', 'u', ${i})`).join(',')
    const valsB = Array.from({ length: 600 }, (_, i) => `('${docB.docId}', 'edit', 'u', ${i})`).join(',')
    await db.query(
      `INSERT INTO activity_log (doc_id, action, user_name, word_count) VALUES ${valsA}, ${valsB}`
    )
    await pruneActivity(docA.docId)
    expect(await activityCount(docA.docId)).toBe(500)
    expect(await activityCount(docB.docId)).toBe(600)
  })

  it('only prunes rows for the target doc', async () => {
    const u = await createUser()
    const docA = await seedDoc({ ownerId: u.id })
    const docB = await seedDoc({ ownerId: u.id })
    const db = testDb()
    // A: 501 rows (over cap). B: 10 rows (under cap).
    const valsA = Array.from({ length: 501 }, (_, i) => `('${docA.docId}', 'edit', 'u', ${i})`).join(',')
    const valsB = Array.from({ length: 10 }, (_, i) => `('${docB.docId}', 'edit', 'u', ${i})`).join(',')
    await db.query(
      `INSERT INTO activity_log (doc_id, action, user_name, word_count) VALUES ${valsA}, ${valsB}`
    )
    await pruneActivity(docA.docId)
    expect(await activityCount(docA.docId)).toBe(500)
    expect(await activityCount(docB.docId)).toBe(10)
  })
})

describe('listRecentActivity', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns entries ordered by createdAt desc, capped at limit', async () => {
    const u = await createUser()
    const doc = await seedDoc({ ownerId: u.id })
    await appendActivity({ docId: doc.docId, userName: 'old', action: 'edit' })
    await new Promise(r => setTimeout(r, 5))
    await appendActivity({ docId: doc.docId, userName: 'new', action: 'edit' })
    const entries = await listRecentActivity(doc.docId, 50)
    expect(entries[0].userName).toBe('new')
    expect(entries[1].userName).toBe('old')
  })

  it('respects the limit argument', async () => {
    const u = await createUser()
    const doc = await seedDoc({ ownerId: u.id })
    for (let i = 0; i < 5; i++) {
      await appendActivity({ docId: doc.docId, userName: `u${i}`, action: 'edit' })
    }
    const entries = await listRecentActivity(doc.docId, 3)
    expect(entries.length).toBe(3)
  })

  it('scopes to the requested doc only', async () => {
    const u = await createUser()
    const docA = await seedDoc({ ownerId: u.id })
    const docB = await seedDoc({ ownerId: u.id })
    await appendActivity({ docId: docA.docId, userName: 'a', action: 'edit' })
    await appendActivity({ docId: docB.docId, userName: 'b', action: 'edit' })
    const entries = await listRecentActivity(docA.docId)
    expect(entries.map(e => e.userName)).toEqual(['a'])
  })
})

describe('deleteActivityForDoc', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('drops every row for that doc, leaves others', async () => {
    const u = await createUser()
    const docA = await seedDoc({ ownerId: u.id })
    const docB = await seedDoc({ ownerId: u.id })
    await appendActivity({ docId: docA.docId, userName: 'a', action: 'edit' })
    await appendActivity({ docId: docB.docId, userName: 'b', action: 'edit' })
    await deleteActivityForDoc(docA.docId)
    expect(await activityCount(docA.docId)).toBe(0)
    expect(await activityCount(docB.docId)).toBe(1)
  })
})
