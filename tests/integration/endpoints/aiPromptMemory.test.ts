import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { loggedInClient } from '../setup/client'
import { createUser, createDoc } from '../setup/fixtures'

// `POST /api/ai/prompt` — conversation-memory wiring. The test
// asserts the integration-level contract:
//
//   "After a successful prompt POST, a `user_prompt` row lands in
//    `ai_session_messages` for the (docId, userId) pair, with the
//    prompt text verbatim."
//
// This is the contract the next prompt's `<conversation_history>`
// block depends on. If it ever regresses, follow-up prompts would
// silently lose context resolution (the user-visible bug: "now put
// it on the first page" stops resolving "it" because the first
// prompt's text isn't being loaded into the system prompt anymore).
//
// We DON'T run the agentic loop end-to-end (that needs the LLM
// upstream, which the integration suite doesn't talk to). The
// user_prompt append happens BEFORE `runAgenticLoop` in
// `prompt.post.ts`, so even when the downstream loop fails (no
// upstream), the memory row is still written. We poll for it
// because the append fires inside the background `void async () =>
// { ... }` block — the HTTP response returns before the row is
// committed.

async function pollForMessageRow(
  docId: string,
  userId: number,
  predicate: (rows: Array<{ kind: string, body: { text?: string } }>) => boolean,
  timeoutMs = 5_000
): Promise<Array<{ kind: string, body: { text?: string } }>> {
  const db = testDb()
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const r = await db.query<{ kind: string, body: { text?: string } }>(
      `SELECT kind, body FROM ai_session_messages
       WHERE doc_id = $1 AND user_id = $2
       ORDER BY id ASC`,
      [docId, userId]
    )
    if (predicate(r.rows)) return r.rows
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  // Final read for the failure assertion.
  const r = await db.query<{ kind: string, body: { text?: string } }>(
    `SELECT kind, body FROM ai_session_messages
     WHERE doc_id = $1 AND user_id = $2
     ORDER BY id ASC`,
    [docId, userId]
  )
  return r.rows
}

describe('POST /api/ai/prompt — conversation memory wiring', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('appends a user_prompt row containing the verbatim prompt text', async () => {
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id })
    const client = await loggedInClient(u.id)

    const promptText = 'Build a complex pricing table comparing all 4 plans'
    const res = await client.post('/api/ai/prompt', {
      docId: doc.docId,
      prompt: promptText
    })
    expect([200, 202]).toContain(res.status)

    // Poll — the append happens in the background async block.
    const rows = await pollForMessageRow(
      doc.docId,
      u.id,
      rows => rows.some(r => r.kind === 'user_prompt')
    )

    const userPromptRow = rows.find(r => r.kind === 'user_prompt')
    expect(userPromptRow).toBeDefined()
    expect(userPromptRow!.body.text).toBe(promptText)
  })

  it('isolates rows by (docId, userId) — does not leak across docs', async () => {
    const u = await createUser()
    const docA = await createDoc({ ownerId: u.id })
    const docB = await createDoc({ ownerId: u.id })
    const client = await loggedInClient(u.id)

    await client.post('/api/ai/prompt', { docId: docA.docId, prompt: 'about doc A' })
    await pollForMessageRow(docA.docId, u.id, rows => rows.some(r => r.kind === 'user_prompt'))

    // Doc B should have NO rows for the same user.
    const db = testDb()
    const r = await db.query<{ c: string }>(
      `SELECT COUNT(*) AS c FROM ai_session_messages WHERE doc_id = $1 AND user_id = $2`,
      [docB.docId, u.id]
    )
    expect(Number(r.rows[0].c)).toBe(0)
  })

  // Phase 6: budget enforcement moved to LiteLLM virtual keys; the
  // app-side 402-pre-check on /api/ai/prompt is gone (no app-side
  // counter to read). The runLoop catches the proxy's 429-translation
  // (`LitellmBudgetExhausted` / `isBudgetExceededError`) and emits a
  // breadcrumb instead. The pre-Phase-6 "no orphan memory row on a
  // budget-rejected prompt" guarantee no longer holds at the
  // session-open boundary because the open succeeds — the rejection
  // happens once the first stream call hits the proxy.
})
