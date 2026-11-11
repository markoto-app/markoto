import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import { runAiRecordsSweep, AI_RECORD_RETENTION_DAYS } from '../../server/utils/ai/aiRecordsSweep'
import { appendAiMessage } from '../../server/repos/aiSessionMessages'
import { createUser, createDoc } from '../integration/setup/fixtures'
import { first } from '../helpers/assert'

// The 90-day AI-record retention sweep. Enforces the privacy policy's
// "AI prompt and tool-call records are retained for 90 days, then purged"
// commitment against `ai_session_messages` (persisted conversation memory)
// and reaps orphaned `ai_sessions` past the same window.

const DAY_MS = 24 * 60 * 60 * 1000

async function backdateMessage(id: number, when: Date): Promise<void> {
  await testDb().query('UPDATE ai_session_messages SET created_at = $1 WHERE id = $2', [when, id])
}

async function latestMessageId(): Promise<number> {
  const r = await testDb().query<{ id: number }>('SELECT id FROM ai_session_messages ORDER BY id DESC LIMIT 1')
  return first(r.rows).id
}

async function messageCount(): Promise<number> {
  const r = await testDb().query<{ c: string }>('SELECT COUNT(*) AS c FROM ai_session_messages')
  return Number(first(r.rows).c)
}

async function seedSession(sessionId: string, userId: number, docId: string, startedAt: Date): Promise<void> {
  await testDb().query(
    `INSERT INTO ai_sessions (session_id, doc_id, initiator_user_id, initiator_name, initiator_color, started_at)
     VALUES ($1, $2, $3, 'Alice', '#abc', $4)`,
    [sessionId, docId, userId, startedAt]
  )
}

async function sessionCount(): Promise<number> {
  const r = await testDb().query<{ c: string }>('SELECT COUNT(*) AS c FROM ai_sessions')
  return Number(first(r.rows).c)
}

describe('runAiRecordsSweep', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('purges ai_session_messages older than 90 days, keeps recent ones', async () => {
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id })

    // One recent, one just-inside, one just-outside the window.
    await appendAiMessage({ docId: doc.docId, userId: u.id, sessionId: 's', kind: 'user_prompt', body: { text: 'recent' } })
    const recentId = await latestMessageId()

    await appendAiMessage({ docId: doc.docId, userId: u.id, sessionId: 's', kind: 'tool_call', body: { name: 'web_search' } })
    const insideId = await latestMessageId()
    await backdateMessage(insideId, new Date(Date.now() - 89 * DAY_MS))

    await appendAiMessage({ docId: doc.docId, userId: u.id, sessionId: 's', kind: 'message_to_user', body: { message: 'old' } })
    const outsideId = await latestMessageId()
    await backdateMessage(outsideId, new Date(Date.now() - 91 * DAY_MS))

    const result = await runAiRecordsSweep()

    expect(result.messagesDeleted).toBe(1)
    const remaining = await testDb().query<{ id: number }>('SELECT id FROM ai_session_messages ORDER BY id')
    const ids = remaining.rows.map(r => r.id)
    expect(ids).toContain(recentId)
    expect(ids).toContain(insideId)
    expect(ids).not.toContain(outsideId)
  })

  it('reaps orphaned ai_sessions older than 90 days, keeps recent ones', async () => {
    const u = await createUser()
    const docOld = await createDoc({ ownerId: u.id })
    const docNew = await createDoc({ ownerId: u.id })

    await seedSession('old-sess', u.id, docOld.docId, new Date(Date.now() - 100 * DAY_MS))
    await seedSession('new-sess', u.id, docNew.docId, new Date(Date.now() - 1 * DAY_MS))

    const result = await runAiRecordsSweep()

    expect(result.sessionsDeleted).toBe(1)
    expect(await sessionCount()).toBe(1)
    const r = await testDb().query<{ session_id: string }>('SELECT session_id FROM ai_sessions')
    expect(first(r.rows).session_id).toBe('new-sess')
  })

  it('respects an injected clock for the cutoff boundary', async () => {
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id })
    await appendAiMessage({ docId: doc.docId, userId: u.id, sessionId: 's', kind: 'user_prompt', body: { text: 'x' } })
    const id = await latestMessageId()
    // 100 days ago relative to real now.
    await backdateMessage(id, new Date(Date.now() - 100 * DAY_MS))

    // A clock 200 days in the PAST makes the 100-day-old row look recent.
    const past = await runAiRecordsSweep(Date.now() - 200 * DAY_MS)
    expect(past.messagesDeleted).toBe(0)
    expect(await messageCount()).toBe(1)

    // Real clock → the row is now beyond the window.
    const now = await runAiRecordsSweep()
    expect(now.messagesDeleted).toBe(1)
    expect(await messageCount()).toBe(0)
  })

  it('is a no-op when nothing is stale', async () => {
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id })
    await appendAiMessage({ docId: doc.docId, userId: u.id, sessionId: 's', kind: 'user_prompt', body: { text: 'fresh' } })

    const result = await runAiRecordsSweep()
    expect(result).toEqual({ messagesDeleted: 0, sessionsDeleted: 0 })
    expect(AI_RECORD_RETENTION_DAYS).toBe(90)
  })
})
