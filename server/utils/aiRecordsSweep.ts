import { lt } from 'drizzle-orm'
import { aiSessionMessages, aiSessions } from '../db/schema'
import { useDatabase } from './database'

// GDPR retention enforcement for AI records.
//
// The privacy policy commits to purging AI prompt + tool-call records
// after 90 days ("AI prompt and tool-call records are retained for 90 days
// for abuse-prevention review, then purged" — content/legal/privacy/en.md).
// Those records are `ai_session_messages` — the per-(doc, user) conversation
// memory (user_prompt / tool_call / message_to_user rows). They PERSIST
// after a session ends; the only other way they disappear is the cascade FK
// on doc/user delete, which has no time bound. This sweep is what actually
// enforces the 90-day promise.
//
// It also reaps orphaned `ai_sessions` rows past the same window. Those are
// normally removed on session end (or by `ai-session-sweep`'s 7-min abort),
// but a crashed cleanup could leave one behind — a stale row past 90 days is
// pure storage cost + a dangling reference to a purged conversation.

export const AI_RECORD_RETENTION_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000

export interface AiRecordsSweepResult {
  messagesDeleted: number
  sessionsDeleted: number
}

/**
 * Delete AI memory rows + orphaned session rows older than the retention
 * window. `now` is injectable for tests; production calls with the default.
 */
export async function runAiRecordsSweep(now: number = Date.now()): Promise<AiRecordsSweepResult> {
  const cutoff = new Date(now - AI_RECORD_RETENTION_DAYS * DAY_MS)
  const db = useDatabase()

  const messages = await db.delete(aiSessionMessages)
    .where(lt(aiSessionMessages.createdAt, cutoff))
    .returning({ id: aiSessionMessages.id })

  const sessions = await db.delete(aiSessions)
    .where(lt(aiSessions.startedAt, cutoff))
    .returning({ sessionId: aiSessions.sessionId })

  return { messagesDeleted: messages.length, sessionsDeleted: sessions.length }
}
