import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import {
  appendAiMessage,
  loadRecentMessages,
  lastActivityAt,
  parseAiMessageEntry
} from '../../server/repos/aiSessionMessages'
import { createUser, createDoc } from '../integration/setup/fixtures'
import { first } from '../helpers/assert'
import { docAs } from '../helpers/access'

// AI conversation memory repo. Append-only by convention; the cascade
// FKs (doc + user) own the only legitimate row-deletion path. Tests
// pin the contract every conversation-memory consumer depends on:
//   - round-trip: append → load returns what was written, in
//     chronological order
//   - windowing by `since` (drives the 60-min idle reset)
//   - `limit` cap
//   - `lastActivityAt` returns the most recent ts
//   - cascades on doc / user delete
// We don't test the cross-doc / cross-user isolation directly here
// because the repo is keyed on (docId, userId) tuples — a miss
// returns [] regardless of why.

async function nowMinusMinutes(min: number): Promise<Date> {
  return new Date(Date.now() - min * 60_000)
}

async function setCreatedAt(id: number, when: Date): Promise<void> {
  // Tests need to fabricate older rows than the repo would naturally
  // produce. The repo always writes `now()`; we override post-insert
  // so loadRecentMessages's `since` filter is exercisable.
  const db = testDb()
  await db.query('UPDATE ai_session_messages SET created_at = $1 WHERE id = $2', [when, id])
}

async function getLatestRowId(): Promise<number> {
  const db = testDb()
  const r = await db.query<{ id: number }>(
    'SELECT id FROM ai_session_messages ORDER BY id DESC LIMIT 1'
  )
  return first(r.rows).id
}

describe('appendAiMessage', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('inserts a row with the supplied fields', async () => {
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id })
    await appendAiMessage(docAs(doc.docId, u.id), {
      sessionId: 'sess-1',
      kind: 'user_prompt',
      body: { text: 'hi markoto' }
    })
    const db = testDb()
    const r = await db.query(
      'SELECT doc_id, user_id, session_id, kind, body FROM ai_session_messages WHERE doc_id = $1',
      [doc.docId]
    )
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]).toMatchObject({
      doc_id: doc.docId,
      user_id: u.id,
      session_id: 'sess-1',
      kind: 'user_prompt',
      body: { text: 'hi markoto' }
    })
  })

  it.each(['user_prompt', 'tool_call', 'message_to_user'] as const)(
    'accepts kind=%s',
    async (kind) => {
      const u = await createUser()
      const doc = await createDoc({ ownerId: u.id })
      await appendAiMessage(docAs(doc.docId, u.id), {
        sessionId: 's',
        ...parseAiMessageEntry(kind, { test: true })
      })
      const rows = await loadRecentMessages(docAs(doc.docId, u.id))
      expect(rows[0]?.kind).toBe(kind)
    }
  )

  it('preserves jsonb body shape across the round-trip', async () => {
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id })
    const body = {
      message: 'A complex pricing table comparing 4 plans',
      isQuestion: false,
      nested: { ok: true, list: [1, 2, 3] }
    }
    await appendAiMessage(docAs(doc.docId, u.id), {
      sessionId: 's',
      kind: 'message_to_user',
      body
    })
    const rows = await loadRecentMessages(docAs(doc.docId, u.id))
    expect(rows[0]?.body).toEqual(body)
  })
})

describe('the proof decides whose memory', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('refuses a proof that names no signed-in user (job, admin, anonymous)', async () => {
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id })
    await expect(appendAiMessage(docAs(doc.docId), { sessionId: 's', kind: 'user_prompt', body: { text: 'x' } })).rejects.toThrow()
    await expect(loadRecentMessages(docAs(doc.docId))).rejects.toThrow()
  })
})

describe('loadRecentMessages', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns rows in chronological order, oldest-first', async () => {
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id })
    // Insert 3 rows; manually backdate so DB-level created_at is
    // distinct (within a single tx the now() values can match).
    await appendAiMessage(docAs(doc.docId, u.id), { sessionId: 's', kind: 'user_prompt', body: { text: 'first' } })
    const id1 = await getLatestRowId()
    await setCreatedAt(id1, await nowMinusMinutes(20))

    await appendAiMessage(docAs(doc.docId, u.id), { sessionId: 's', kind: 'user_prompt', body: { text: 'second' } })
    const id2 = await getLatestRowId()
    await setCreatedAt(id2, await nowMinusMinutes(10))

    await appendAiMessage(docAs(doc.docId, u.id), { sessionId: 's', kind: 'user_prompt', body: { text: 'third' } })
    const id3 = await getLatestRowId()
    await setCreatedAt(id3, await nowMinusMinutes(1))

    const rows = await loadRecentMessages(docAs(doc.docId, u.id))
    expect(rows).toHaveLength(3)
    expect(rows.map(r => (r.body as { text: string }).text)).toEqual(['first', 'second', 'third'])
  })

  it('respects the `since` window — older rows are excluded', async () => {
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id })

    // Fabricate one ancient row + two recent rows.
    await appendAiMessage(docAs(doc.docId, u.id), { sessionId: 's', kind: 'user_prompt', body: { text: 'ancient' } })
    await setCreatedAt(await getLatestRowId(), await nowMinusMinutes(180))

    await appendAiMessage(docAs(doc.docId, u.id), { sessionId: 's', kind: 'user_prompt', body: { text: 'recent-1' } })
    await setCreatedAt(await getLatestRowId(), await nowMinusMinutes(30))

    await appendAiMessage(docAs(doc.docId, u.id), { sessionId: 's', kind: 'user_prompt', body: { text: 'recent-2' } })
    await setCreatedAt(await getLatestRowId(), await nowMinusMinutes(5))

    // Window: last 60 min only.
    const since = await nowMinusMinutes(60)
    const rows = await loadRecentMessages(docAs(doc.docId, u.id), { since })
    expect(rows.map(r => (r.body as { text: string }).text)).toEqual(['recent-1', 'recent-2'])
  })

  it('caps results at the supplied `limit`, keeping the most recent', async () => {
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id })
    for (let i = 0; i < 10; i++) {
      await appendAiMessage(docAs(doc.docId, u.id), { sessionId: 's', kind: 'user_prompt', body: { text: `p${i}` } })
      await setCreatedAt(await getLatestRowId(), new Date(Date.now() - (10 - i) * 60_000))
    }
    const rows = await loadRecentMessages(docAs(doc.docId, u.id), { limit: 3 })
    // Most-recent 3 in chronological order.
    expect(rows.map(r => (r.body as { text: string }).text)).toEqual(['p7', 'p8', 'p9'])
  })

  it('clamps absurd limits at 200', async () => {
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id })
    await appendAiMessage(docAs(doc.docId, u.id), { sessionId: 's', kind: 'user_prompt', body: { text: 'x' } })
    // Should not crash on a huge limit; the repo internally capped to 200.
    const rows = await loadRecentMessages(docAs(doc.docId, u.id), { limit: 999_999 })
    expect(rows).toHaveLength(1)
  })

  it('returns rows for the queried (docId, userId) only', async () => {
    const u1 = await createUser()
    const u2 = await createUser()
    const docA = await createDoc({ ownerId: u1.id })
    const docB = await createDoc({ ownerId: u1.id })

    await appendAiMessage(docAs(docA.docId, u1.id), { sessionId: 's', kind: 'user_prompt', body: { text: 'A-u1' } })
    await appendAiMessage(docAs(docA.docId, u2.id), { sessionId: 's', kind: 'user_prompt', body: { text: 'A-u2' } })
    await appendAiMessage(docAs(docB.docId, u1.id), { sessionId: 's', kind: 'user_prompt', body: { text: 'B-u1' } })

    // Cross-doc isolation
    const aRows = await loadRecentMessages(docAs(docA.docId, u1.id))
    expect(aRows.map(r => (r.body as { text: string }).text)).toEqual(['A-u1'])

    // Cross-user isolation on the same doc
    const aRowsForU2 = await loadRecentMessages(docAs(docA.docId, u2.id))
    expect(aRowsForU2.map(r => (r.body as { text: string }).text)).toEqual(['A-u2'])
  })

  it('returns [] for unknown (docId, userId)', async () => {
    expect(await loadRecentMessages(docAs('nope', 0))).toEqual([])
  })
})

describe('lastActivityAt', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns null when no rows exist for the pair', async () => {
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id })
    expect(await lastActivityAt(docAs(doc.docId, u.id))).toBeNull()
  })

  it('returns the timestamp of the most recent row', async () => {
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id })
    const ancient = await nowMinusMinutes(120)
    const recent = await nowMinusMinutes(2)

    await appendAiMessage(docAs(doc.docId, u.id), { sessionId: 's', kind: 'user_prompt', body: { text: 'a' } })
    await setCreatedAt(await getLatestRowId(), ancient)
    await appendAiMessage(docAs(doc.docId, u.id), { sessionId: 's', kind: 'user_prompt', body: { text: 'b' } })
    await setCreatedAt(await getLatestRowId(), recent)

    const ts = await lastActivityAt(docAs(doc.docId, u.id))
    expect(ts).toBeInstanceOf(Date)
    // Tolerate the millisecond round-trip through Postgres.
    expect(Math.abs(ts!.getTime() - recent.getTime())).toBeLessThan(1000)
  })

  it('isolates by (docId, userId) like loadRecentMessages does', async () => {
    const u1 = await createUser()
    const u2 = await createUser()
    const doc = await createDoc({ ownerId: u1.id })
    await appendAiMessage(docAs(doc.docId, u1.id), { sessionId: 's', kind: 'user_prompt', body: { text: 'x' } })
    expect(await lastActivityAt(docAs(doc.docId, u2.id))).toBeNull()
    expect(await lastActivityAt(docAs(doc.docId, u1.id))).toBeInstanceOf(Date)
  })
})

describe('cascade deletes', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('cascades on doc delete', async () => {
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id })
    await appendAiMessage(docAs(doc.docId, u.id), { sessionId: 's', kind: 'user_prompt', body: { text: 'x' } })
    expect((await loadRecentMessages(docAs(doc.docId, u.id))).length).toBe(1)

    const db = testDb()
    await db.query('DELETE FROM documents WHERE doc_id = $1', [doc.docId])
    expect((await loadRecentMessages(docAs(doc.docId, u.id))).length).toBe(0)
  })

  it('cascades on user delete', async () => {
    // Privacy guarantee: when the account is purged, the user's AI
    // conversation history goes too. Differs from activity_log, where
    // user_id is `set null` to keep history while anonymising.
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id })
    await appendAiMessage(docAs(doc.docId, u.id), { sessionId: 's', kind: 'user_prompt', body: { text: 'x' } })
    expect((await loadRecentMessages(docAs(doc.docId, u.id))).length).toBe(1)

    const db = testDb()
    // documents.owner_id is `set null` on user delete, so the doc
    // survives — but ai_session_messages.user_id is `cascade`.
    await db.query('UPDATE documents SET owner_id = NULL WHERE doc_id = $1', [doc.docId])
    await db.query('DELETE FROM users WHERE id = $1', [u.id])

    const r = await db.query<{ c: string }>(
      'SELECT COUNT(*) AS c FROM ai_session_messages WHERE doc_id = $1', [doc.docId]
    )
    expect(Number(first(r.rows).c)).toBe(0)
  })
})
