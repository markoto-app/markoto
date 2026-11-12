import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import { createDoc, createUser, createWorkspace, setMemberRole } from '../integration/setup/fixtures'
import { countOtherWorkspaceEditors, hasForeignContentActivity } from '../../server/repos/docProvenance'
import {
  listAiSessionProvenanceForUser,
  markAiSessionProvenanceClean,
  recordAiSessionProvenance
} from '../../server/repos/aiSessionProvenance'
import { asUser, docAs, wsAs } from '../helpers/access'

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
    expect(await hasForeignContentActivity(docAs(doc.docId), alice.id)).toBe(false)
  })

  it('a session that was tainted when it wrote stays foreign', async () => {
    const alice = await createUser({ name: 'Alice' })
    const doc = await createDoc({ ownerId: alice.id })
    await recordAiSessionProvenance('s-tainted', doc.docId, alice.id)
    await aiEdit(doc.docId, 's-tainted')
    // Never marked clean.
    expect(await hasForeignContentActivity(docAs(doc.docId), alice.id)).toBe(true)
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
    expect(await hasForeignContentActivity(docAs(doc.docId), alice.id)).toBe(true)
  })

  it('a clean session of ANOTHER user is foreign', async () => {
    const alice = await createUser({ name: 'Alice' })
    const bob = await createUser({ name: 'Bob' })
    const doc = await createDoc({ ownerId: alice.id })
    await recordAiSessionProvenance('s-bob', doc.docId, bob.id)
    await aiEdit(doc.docId, 's-bob')
    await markAiSessionProvenanceClean('s-bob')
    expect(await hasForeignContentActivity(docAs(doc.docId), alice.id)).toBe(true)
    // … and it is Bob's own.
    expect(await hasForeignContentActivity(docAs(doc.docId), bob.id)).toBe(false)
  })

  it('an AI edit with no provenance and no legacy attribution is foreign', async () => {
    const alice = await createUser({ name: 'Alice' })
    const doc = await createDoc({ ownerId: alice.id })
    await aiEdit(doc.docId, 's-unknown')
    expect(await hasForeignContentActivity(docAs(doc.docId), alice.id)).toBe(true)
  })

  it('pre-provenance sessions keep the legacy rule (conversation memory of the invoker)', async () => {
    const alice = await createUser({ name: 'Alice' })
    const doc = await createDoc({ ownerId: alice.id })
    await aiEdit(doc.docId, 's-legacy')
    await testDb().query(
      `INSERT INTO ai_session_messages (doc_id, user_id, session_id, kind, body) VALUES ($1, $2, 's-legacy', 'user_prompt', '{"text":"hi"}')`,
      [doc.docId, alice.id]
    )
    expect(await hasForeignContentActivity(docAs(doc.docId), alice.id)).toBe(false)
  })

  it('provenance rows go with the user (FK cascade) — their AI edits then count as foreign', async () => {
    const alice = await createUser({ name: 'Alice' })
    const bob = await createUser({ name: 'Bob' })
    const doc = await createDoc({ ownerId: alice.id })
    await recordAiSessionProvenance('s-gone', doc.docId, bob.id)
    await markAiSessionProvenanceClean('s-gone')
    expect(await listAiSessionProvenanceForUser(asUser(bob.id))).toHaveLength(1)
    await testDb().query('DELETE FROM users WHERE id = $1', [bob.id])
    const left = await testDb().query('SELECT 1 FROM ai_session_provenance WHERE session_id = $1', ['s-gone'])
    expect(left.rows).toHaveLength(0)
  })
})

describe('countOtherWorkspaceEditors — guests with an edit share', () => {
  beforeEach(async () => {
    await resetDb()
  })

  async function share(docId: string, userId: number, access: 'view' | 'edit'): Promise<void> {
    await testDb().query('INSERT INTO document_shares (doc_id, user_id, access) VALUES ($1, $2, $3)', [docId, userId, access])
  }

  it('a single-admin workspace has no other editors until a guest gets an edit share', async () => {
    const admin = await createUser({ name: 'Maya Admin' })
    const ws = await createWorkspace(admin.id)
    const guest = await createUser({ name: 'Gus Guest' })
    await setMemberRole(ws.workspaceId, guest.id, 'guest')
    const doc = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId })
    expect(await countOtherWorkspaceEditors(wsAs(ws.workspaceId), admin.id)).toBe(0)

    // A view share can't change any text.
    await share(doc.docId, guest.id, 'view')
    expect(await countOtherWorkspaceEditors(wsAs(ws.workspaceId), admin.id)).toBe(0)

    // An edit share can (text, title, description) — the admin's AI
    // reading workspace titles must now ask first.
    await testDb().query('UPDATE document_shares SET access = \'edit\' WHERE doc_id = $1 AND user_id = $2', [doc.docId, guest.id])
    expect(await countOtherWorkspaceEditors(wsAs(ws.workspaceId), admin.id)).toBe(1)
  })

  it('counts each person once, never the invoker, and only shares on the workspace\'s own documents', async () => {
    const admin = await createUser({ name: 'Maya Admin' })
    const ws = await createWorkspace(admin.id)
    const editor = await createUser({ name: 'Ed Editor' })
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    const guest = await createUser({ name: 'Gus Guest' })
    await setMemberRole(ws.workspaceId, guest.id, 'guest')
    const docA = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId })
    const docB = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId })
    await share(docA.docId, guest.id, 'edit')
    await share(docB.docId, guest.id, 'edit')
    expect(await countOtherWorkspaceEditors(wsAs(ws.workspaceId), admin.id)).toBe(2)
    // From the guest's own point of view, their shares don't count.
    expect(await countOtherWorkspaceEditors(wsAs(ws.workspaceId), guest.id)).toBe(2)

    // An edit share in ANOTHER workspace doesn't make this one shared.
    const otherAdmin = await createUser({ name: 'Olga Other' })
    const otherWs = await createWorkspace(otherAdmin.id)
    const otherDoc = await createDoc({ ownerId: otherAdmin.id, workspaceId: otherWs.workspaceId })
    const outsider = await createUser({ name: 'Out Sider' })
    await setMemberRole(otherWs.workspaceId, outsider.id, 'guest')
    await share(otherDoc.docId, outsider.id, 'edit')
    expect(await countOtherWorkspaceEditors(wsAs(ws.workspaceId), admin.id)).toBe(2)
  })
})
