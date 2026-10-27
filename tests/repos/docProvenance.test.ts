import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import { createDoc, createUser } from '../integration/setup/fixtures'
import { hasForeignContentActivity } from '../../server/repos/docProvenance'
import {
  listAiSessionProvenanceForUser,
  markAiSessionProvenanceClean,
  recordAiSessionProvenance
} from '../../server/repos/aiSessionProvenance'

// Provenance of AI edits for the taint gate (F-7b). An edit by
// `ai:assistant:<sid>` counts as the invoker's own text only when the
// session's provenance row belongs to them AND was marked clean (the
// session never read anybody else's content). Everything else — another
// user's session, a tainted session, a session that is still running or
// crashed — stays foreign.

async function aiEdit(docId: string, sessionId: string): Promise<void> {
  await testDb().query(
    `INSERT INTO activity_log (doc_id, user_name, action, actor_principal)
     VALUES ($1, 'markoto', 'edit', $2)`,
    [docId, `ai:assistant:${sessionId}`]
  )
}

async function ownEdit(docId: string, userId: number): Promise<void> {
  await testDb().query(
    `INSERT INTO activity_log (doc_id, user_id, user_name, action) VALUES ($1, $2, 'Alice', 'edit')`,
    [docId, userId]
  )
}

describe('hasForeignContentActivity — AI session provenance', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('an @ai / prompt session of the invoker that stayed clean counts as their own after it ended', async () => {
    const alice = await createUser({ name: 'Alice' })
    const doc = await createDoc({ ownerId: alice.id })
    await ownEdit(doc.docId, alice.id)
    await recordAiSessionProvenance('s-clean', doc.docId, alice.id)
    await aiEdit(doc.docId, 's-clean')
    // No ai_sessions row (deleted at session end) and no conversation
    // memory (the @ai trigger writes none) — before provenance, this
    // edit was unattributable and the doc counted as shared.
    await markAiSessionProvenanceClean('s-clean')
    expect(await hasForeignContentActivity(doc.docId, alice.id)).toBe(false)
  })

  it('a session that was tainted when it wrote stays foreign', async () => {
    const alice = await createUser({ name: 'Alice' })
    const doc = await createDoc({ ownerId: alice.id })
    await recordAiSessionProvenance('s-tainted', doc.docId, alice.id)
    await aiEdit(doc.docId, 's-tainted')
    // Never marked clean.
    expect(await hasForeignContentActivity(doc.docId, alice.id)).toBe(true)
  })

  it('a tainted session stays foreign even with conversation memory and a live session row of the invoker', async () => {
    const alice = await createUser({ name: 'Alice' })
    const doc = await createDoc({ ownerId: alice.id })
    await recordAiSessionProvenance('s-mem', doc.docId, alice.id)
    await aiEdit(doc.docId, 's-mem')
    await testDb().query(
      `INSERT INTO ai_session_messages (doc_id, user_id, session_id, kind, body) VALUES ($1, $2, 's-mem', 'user_prompt', '{"text":"hi"}')`,
      [doc.docId, alice.id]
    )
    await testDb().query(
      `INSERT INTO ai_sessions (session_id, doc_id, initiator_user_id, initiator_name, initiator_color) VALUES ('s-mem', $1, $2, 'Alice', '#000')`,
      [doc.docId, alice.id]
    )
    expect(await hasForeignContentActivity(doc.docId, alice.id)).toBe(true)
  })

  it('a clean session of ANOTHER user is foreign', async () => {
    const alice = await createUser({ name: 'Alice' })
    const bob = await createUser({ name: 'Bob' })
    const doc = await createDoc({ ownerId: alice.id })
    await recordAiSessionProvenance('s-bob', doc.docId, bob.id)
    await aiEdit(doc.docId, 's-bob')
    await markAiSessionProvenanceClean('s-bob')
    expect(await hasForeignContentActivity(doc.docId, alice.id)).toBe(true)
    // … and it is Bob's own.
    expect(await hasForeignContentActivity(doc.docId, bob.id)).toBe(false)
  })

  it('an AI edit with no provenance and no legacy attribution is foreign', async () => {
    const alice = await createUser({ name: 'Alice' })
    const doc = await createDoc({ ownerId: alice.id })
    await aiEdit(doc.docId, 's-unknown')
    expect(await hasForeignContentActivity(doc.docId, alice.id)).toBe(true)
  })

  it('pre-provenance sessions keep the legacy rule (conversation memory of the invoker)', async () => {
    const alice = await createUser({ name: 'Alice' })
    const doc = await createDoc({ ownerId: alice.id })
    await aiEdit(doc.docId, 's-legacy')
    await testDb().query(
      `INSERT INTO ai_session_messages (doc_id, user_id, session_id, kind, body) VALUES ($1, $2, 's-legacy', 'user_prompt', '{"text":"hi"}')`,
      [doc.docId, alice.id]
    )
    expect(await hasForeignContentActivity(doc.docId, alice.id)).toBe(false)
  })

  it('provenance rows go with the user (FK cascade) — their AI edits then count as foreign', async () => {
    const alice = await createUser({ name: 'Alice' })
    const bob = await createUser({ name: 'Bob' })
    const doc = await createDoc({ ownerId: alice.id })
    await recordAiSessionProvenance('s-gone', doc.docId, bob.id)
    await markAiSessionProvenanceClean('s-gone')
    expect(await listAiSessionProvenanceForUser(bob.id)).toHaveLength(1)
    await testDb().query('DELETE FROM users WHERE id = $1', [bob.id])
    const left = await testDb().query('SELECT 1 FROM ai_session_provenance WHERE session_id = $1', ['s-gone'])
    expect(left.rows).toHaveLength(0)
  })
})
