import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import { createUser, createDoc, createWorkspace, setMemberRole } from '../setup/fixtures'

// End-to-end integration tests for the cross-document tools
// (`list_workspace_documents`, `list_my_documents`, `search_documents`,
// `view_other_document`). Drives the FULL server stack:
//
//   - Auth via session cookie (loggedInClient → /_test/login)
//   - Real workspace_members rows for access checks
//   - Real /api/_test/exec-ai-tool endpoint dispatching to
//     `executeFunctionByName` against an AI session anchored on a
//     real document row
//
// SCOPE NOTE: integration tests run WITHOUT the Hocuspocus sync
// container (the in-process syncStub only replays HTTP /internal
// calls, not WebSocket Y.js sync). So the SUCCESS path for
// `view_other_document` (which opens openTrustedCommentClient to
// read live ytext) cannot be exercised here, those branches are
// covered by the layer-1 unit tests in `tests/unit/ai/crossDocAiTools.test.ts`,
// which mock the trusted client and exercise the body-formatting
// contract.
//
// What IS covered here:
//   - All ACCESS-DENIAL branches (short-circuit before any sync open):
//     missing doc, stranger-on-private, password-required, cross-
//     workspace isolation, current-doc rejection, garbage URL parsing.
//   - The list and search tools (no sync needed, pure SQL through the
//     explorer's `listDocsPage` / `searchEverywhere`).
//   - Mid-session membership drift: confirms a member who LOSES
//     workspace access mid-conversation gets the same denial path
//     on subsequent reads (real DB mutation between calls).
//
// Each test asserts on DESIRED behaviour, not implementation
// details: message fragments, not full prose, so cosmetic copy
// changes don't break tests but contract violations do.

interface ToolResult {
  isError: boolean
  content: string
}

async function execTool(
  client: { post: (path: string, body: unknown) => Promise<Response> },
  docId: string,
  name: string,
  args: Record<string, unknown>
): Promise<{ status: number, body: ToolResult }> {
  const res = await client.post('/api/_test/exec-ai-tool', { docId, name, args })
  return { status: res.status, body: await res.json() as ToolResult }
}

describe('POST /api/_test/exec-ai-tool: gating', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('rejects anonymous callers with 401', async () => {
    // Spec: the test endpoint is gated by the same session check
    // every other authenticated route uses. A regression that
    // skipped auth here would let any test "log in as anyone".
    const res = await anonClient().post('/api/_test/exec-ai-tool', {
      docId: 'x',
      name: 'list_workspace_documents',
      args: {}
    })
    expect(res.status).toBe(401)
  })

  it('rejects a missing docId with 400', async () => {
    const user = await createUser()
    const client = await loggedInClient(user.id)
    const res = await client.post('/api/_test/exec-ai-tool', {
      name: 'list_workspace_documents',
      args: {}
    })
    expect(res.status).toBe(400)
  })

  it('rejects a non-existent anchor docId with 404', async () => {
    const user = await createUser()
    const client = await loggedInClient(user.id)
    const res = await client.post('/api/_test/exec-ai-tool', {
      docId: 'definitely-does-not-exist',
      name: 'list_workspace_documents',
      args: {}
    })
    expect(res.status).toBe(404)
  })
})

// list_workspace_documents / list_my_documents / search_documents: full-stack

interface ListPayload {
  total: number
  documents: Array<{ doc_id: string, title: string, current_document?: boolean }>
  next_cursor: string | null
}

describe('list_workspace_documents: full-stack', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns the workspace documents for an admin, the anchor marked as current', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    await setMemberRole(ws.workspaceId, owner.id, 'admin')
    const anchor = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId, title: 'Anchor doc' })
    const docB = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId, title: 'Sibling-B' })
    const docC = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId, title: 'Sibling-C' })

    const client = await loggedInClient(owner.id)
    const { status, body } = await execTool(client, anchor.docId, 'list_workspace_documents', {})

    expect(status).toBe(200)
    expect(body.isError).toBe(false)
    const parsed = JSON.parse(body.content) as ListPayload
    expect(parsed.total).toBe(3)
    expect(parsed.documents.map(d => d.doc_id).sort()).toEqual([anchor.docId, docB.docId, docC.docId].sort())
    expect(parsed.documents.find(d => d.doc_id === anchor.docId)?.current_document).toBe(true)
    expect(parsed.documents.find(d => d.doc_id === docB.docId)?.current_document).toBeUndefined()
    expect(parsed.next_cursor).toBe(null)
  })

  it('pages with limit and cursor', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const anchor = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId })
    for (let i = 0; i < 2; i++) await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId })
    const client = await loggedInClient(owner.id)
    const first = JSON.parse((await execTool(client, anchor.docId, 'list_workspace_documents', { limit: 2 })).body.content) as ListPayload
    expect(first.documents).toHaveLength(2)
    expect(first.next_cursor).toBeTruthy()
    const second = JSON.parse((await execTool(client, anchor.docId, 'list_workspace_documents', { limit: 2, cursor: first.next_cursor })).body.content) as ListPayload
    expect(second.documents).toHaveLength(1)
    expect(second.next_cursor).toBe(null)
    expect(new Set([...first.documents, ...second.documents].map(d => d.doc_id)).size).toBe(3)
  })

  it('errors when the anchor doc is standalone (not in a workspace)', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id }) // no workspaceId
    const client = await loggedInClient(user.id)
    const { body } = await execTool(client, doc.docId, 'list_workspace_documents', {})
    expect(body.isError).toBe(true)
    expect(body.content.toLowerCase()).toContain('workspace')
  })

  it('a folder of another workspace is a tool error, not a leak', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const other = await createWorkspace(owner.id)
    await testDb().query(`INSERT INTO folders (folder_id, workspace_id, name) VALUES ('f-other', $1, 'Other')`, [other.workspaceId])
    const anchor = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId })
    const client = await loggedInClient(owner.id)
    const { body } = await execTool(client, anchor.docId, 'list_workspace_documents', { folder_id: 'f-other' })
    expect(body.isError).toBe(true)
  })

  it('viewer member can list workspace documents (read-only access is enough)', async () => {
    const owner = await createUser()
    const viewer = await createUser()
    const ws = await createWorkspace(owner.id)
    await setMemberRole(ws.workspaceId, owner.id, 'admin')
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
    const anchor = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId, title: 'Anchor' })
    const docB = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId, title: 'Sibling-B' })

    const client = await loggedInClient(viewer.id)
    const { body } = await execTool(client, anchor.docId, 'list_workspace_documents', {})
    expect(body.isError).toBe(false)
    expect(body.content).toContain(docB.docId)
  })

  it('serialises compact rows with snake_case field names (contract for the AI prompt)', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const anchor = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId })
    await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId, title: 'Sibling' })
    const client = await loggedInClient(owner.id)
    const { body } = await execTool(client, anchor.docId, 'list_workspace_documents', {})
    expect(body.isError).toBe(false)
    expect(body.content).toContain('"doc_id"')
    expect(body.content).toContain('"folder"')
    expect(body.content).toContain('"last_edited"')
    expect(body.content).toContain('"next_cursor"')
    expect(body.content).not.toContain('"docId"')
  })
})

describe('list_my_documents and search_documents: full-stack', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('list_my_documents returns the personal documents, not the workspace ones', async () => {
    const user = await createUser()
    const ws = await createWorkspace(user.id)
    const anchor = await createDoc({ ownerId: user.id, workspaceId: ws.workspaceId })
    const personal = await createDoc({ ownerId: user.id, title: 'Personal' })
    const client = await loggedInClient(user.id)
    const { body } = await execTool(client, anchor.docId, 'list_my_documents', {})
    const parsed = JSON.parse(body.content) as ListPayload
    expect(parsed.documents.map(d => d.doc_id)).toEqual([personal.docId])
  })

  it('search_documents finds what the caller can open and nothing of other workspaces', async () => {
    const user = await createUser()
    const stranger = await createUser()
    const ws = await createWorkspace(user.id, { name: 'Mine' })
    const theirs = await createWorkspace(stranger.id)
    const anchor = await createDoc({ ownerId: user.id, workspaceId: ws.workspaceId })
    const hit = await createDoc({ ownerId: user.id, workspaceId: ws.workspaceId, title: 'Launch checklist' })
    const hidden = await createDoc({ ownerId: stranger.id, workspaceId: theirs.workspaceId, title: 'Launch secrets' })
    await testDb().query(`INSERT INTO document_search (doc_id, title, body) VALUES ($1, 'Launch checklist', 'launch steps'), ($2, 'Launch secrets', 'launch codes')`, [hit.docId, hidden.docId])

    const client = await loggedInClient(user.id)
    const { body } = await execTool(client, anchor.docId, 'search_documents', { query: 'launch' })
    expect(body.isError).toBe(false)
    const parsed = JSON.parse(body.content) as { results: Array<{ doc_id: string, workspace: { name: string } | null }> }
    expect(parsed.results.map(r => r.doc_id)).toEqual([hit.docId])
    expect(parsed.results[0]?.workspace?.name).toBe('Mine')
    expect(body.content).not.toContain('secrets')
  })
})

// view_other_document: access-denial branches (no sync needed)

describe('view_other_document: anti-enumeration (404-shape)', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns 404-shape for a fully nonexistent target id', async () => {
    const user = await createUser()
    const anchor = await createDoc({ ownerId: user.id })
    const client = await loggedInClient(user.id)
    const { body } = await execTool(client, anchor.docId, 'view_other_document', {
      doc_id: 'no-such-doc-xyz'
    })
    expect(body.isError).toBe(true)
    expect(body.content.toLowerCase()).toContain('not found')
  })

  it('returns 404-shape (NOT a forbidden message) when reading a stranger\'s private doc', async () => {
    // CRITICAL property: someone guessing private doc ids must NOT
    // learn from the message whether the id exists.
    const owner = await createUser()
    const stranger = await createUser()
    const anchor = await createDoc({ ownerId: stranger.id })
    const target = await createDoc({
      ownerId: owner.id,
      accessMode: 'private',
      title: 'Confidential briefing notes'
    })

    const client = await loggedInClient(stranger.id)
    const { body } = await execTool(client, anchor.docId, 'view_other_document', { doc_id: target.docId })

    expect(body.isError).toBe(true)
    expect(body.content.toLowerCase()).toContain('not found')
    // Critical: must NOT use the word "forbidden", that distinguishes
    // "exists" from "doesn't exist" and breaks anti-enumeration.
    expect(body.content.toLowerCase()).not.toContain('forbidden')
    // Must NOT leak the doc title, that would defeat the 404-shape
    // even more directly than a wording difference.
    expect(body.content).not.toContain('Confidential briefing notes')
  })

  it('returns 404-shape when accessing a private doc in a DIFFERENT workspace (cross-workspace isolation)', async () => {
    // Spec: workspace A membership does NOT grant access to workspace B.
    // This is the test that catches "did the access helper accidentally
    // accept any workspace_role at all" regressions.
    const a = await createUser()
    const b = await createUser()
    const wsA = await createWorkspace(a.id)
    const wsB = await createWorkspace(b.id)
    await setMemberRole(wsA.workspaceId, a.id, 'admin')
    await setMemberRole(wsB.workspaceId, b.id, 'admin')
    const anchorInA = await createDoc({ ownerId: a.id, workspaceId: wsA.workspaceId })
    const targetInB = await createDoc({
      ownerId: b.id,
      workspaceId: wsB.workspaceId,
      accessMode: 'private',
      title: 'B internal'
    })

    const client = await loggedInClient(a.id)
    const { body } = await execTool(client, anchorInA.docId, 'view_other_document', {
      doc_id: targetInB.docId
    })
    expect(body.isError).toBe(true)
    expect(body.content.toLowerCase()).toContain('not found')
    expect(body.content).not.toContain('B internal')
  })
})

describe('view_other_document: password gate', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('non-member of password-protected doc gets the password message (NOT 404)', async () => {
    // Spec: when the user is recognised but the doc requires a
    // password they don't have, the message must EXPLAIN, so the
    // user can ask for a share. We don't 404-mask here because
    // that would hide a fixable problem from the user.
    const owner = await createUser()
    const stranger = await createUser()
    const anchor = await createDoc({ ownerId: stranger.id })
    const target = await createDoc({
      ownerId: owner.id,
      accessMode: 'password-protected',
      passwordHash: 'x',
      title: 'Locked doc'
    })

    const client = await loggedInClient(stranger.id)
    const { body } = await execTool(client, anchor.docId, 'view_other_document', { doc_id: target.docId })
    expect(body.isError).toBe(true)
    expect(body.content.toLowerCase()).toContain('password')
    // Must not say "not found", distinguishes from 404-shape.
    expect(body.content.toLowerCase()).not.toContain('not found')
  })
})

describe('view_other_document: current-doc rejection', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('rejects when the target id matches the anchor doc', async () => {
    // Spec: must be rejected without leaking anything; model
    // is steered toward view_document.
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })
    const client = await loggedInClient(user.id)
    const { body } = await execTool(client, doc.docId, 'view_other_document', { doc_id: doc.docId })
    expect(body.isError).toBe(true)
    expect(body.content.toLowerCase()).toContain('view_document')
  })

  it('rejects when a URL form resolves to the anchor doc', async () => {
    // Spec: same rule, but the user pasted a URL pointing at the
    // current doc. URL parsing happens BEFORE the rejection check,
    // so the same 'view_document' message must come out.
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })
    const client = await loggedInClient(user.id)
    const { body } = await execTool(client, doc.docId, 'view_other_document', {
      doc_id: `https://markoto.app/d/${doc.docId}/?slide=2`
    })
    expect(body.isError).toBe(true)
    expect(body.content.toLowerCase()).toContain('view_document')
  })
})

describe('view_other_document: URL parsing', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('rejects truly garbage input with a parse error (NOT 404-shape)', async () => {
    // Spec: garbage input must explain the parsing problem so the
    // model self-corrects. 404-masking here would hide a real bug
    // from the user.
    const user = await createUser()
    const anchor = await createDoc({ ownerId: user.id })
    const client = await loggedInClient(user.id)
    const { body } = await execTool(client, anchor.docId, 'view_other_document', {
      doc_id: 'this is not an id and not a URL either'
    })
    expect(body.isError).toBe(true)
    expect(body.content.toLowerCase()).toMatch(/markoto url|extract|parse/i)
    // Must NOT say "not found", that would hide the parse failure.
    expect(body.content.toLowerCase()).not.toContain('not found')
  })

  it('a URL pointing at a non-existent doc still goes through to a 404-shape', async () => {
    // Spec: parsing succeeds, then access check fires. The error
    // shape that comes back must be the 404-shape (not a parse
    // error), because the id was extracted successfully.
    const user = await createUser()
    const anchor = await createDoc({ ownerId: user.id })
    const client = await loggedInClient(user.id)
    const { body } = await execTool(client, anchor.docId, 'view_other_document', {
      doc_id: 'https://markoto.app/d/parsable-but-fake'
    })
    expect(body.isError).toBe(true)
    expect(body.content.toLowerCase()).toContain('not found')
  })
})

// Mid-session membership drift

describe('view_other_document: membership drift', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('a former workspace member loses access after their membership row is deleted', async () => {
    // Spec: the access check is per-call. Even though we can't
    // exercise the SUCCESS half here without sync, we CAN confirm
    // that AFTER membership is removed the same call returns the
    // 404-shape: which proves the access decision is recomputed
    // per invocation rather than cached at session-open time.
    const owner = await createUser()
    const evictee = await createUser()
    const ws = await createWorkspace(owner.id)
    await setMemberRole(ws.workspaceId, owner.id, 'admin')
    await setMemberRole(ws.workspaceId, evictee.id, 'editor')
    const anchor = await createDoc({ ownerId: evictee.id })
    const target = await createDoc({
      ownerId: owner.id,
      workspaceId: ws.workspaceId,
      accessMode: 'private',
      title: 'WS-internal: must not leak after eviction'
    })

    // While member: list_workspace_documents (no sync needed) sees
    // the workspace, confirming the membership is real.
    const client = await loggedInClient(evictee.id)
    const { body: anchorListing } = await execTool(
      client,
      target.docId, // target is in the workspace too, list works
      'list_workspace_documents',
      {}
    )
    expect(anchorListing.isError).toBe(false)

    // Drop membership.
    await testDb().query(
      'DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [ws.workspaceId, evictee.id]
    )

    // After eviction: view_other_document on the target now 404s.
    // This proves the access check ran AGAINST current DB state,
    // not a cached session.
    const { body: afterRemoval } = await execTool(
      client,
      anchor.docId,
      'view_other_document',
      { doc_id: target.docId }
    )
    expect(afterRemoval.isError).toBe(true)
    expect(afterRemoval.content.toLowerCase()).toContain('not found')
    expect(afterRemoval.content).not.toContain('WS-internal')
  })
})
