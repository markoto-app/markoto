import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from '../setup/db'
import { createDoc, createUser, createWorkspace, setMemberRole } from '../setup/fixtures'
import { mcp, mintPat } from '../setup/mcpClient'

// Cross-boundary authz on the MCP surface. The contract is:
//   - "Doc not visible" and "doc doesn't exist" return the SAME shape
//     (404-shape isError + "not found" text). Anti-enumeration —
//     leaking "this docId exists but you can't see it" lets a PAT
//     holder enumerate the doc namespace.
//   - Workspace tools follow the same anti-enumeration policy
//     (workspace-not-found vs workspace-without-membership look
//     identical from the caller's side).
//   - Per-tool scope gating is in auth.test.ts; this file covers
//     intra-scope authz (the PAT has the scope but lacks access to
//     the specific resource).

const READ_SCOPES = ['documents:read'] as const
const WRITE_SCOPES = ['documents:read', 'documents:write'] as const
const KNOWLEDGE_SCOPES = ['knowledge:read'] as const

describe('MCP authz — cross-user document access', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('view_document on another user\'s private doc → 404 isError', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
    const stranger = await createUser()
    const { plaintext } = await mintPat({ userId: stranger.id, scopes: READ_SCOPES })

    const res = await mcp(plaintext).call('view_document', { doc_id: doc.docId })
    expect(res.isError).toBe(true)
    expect(res.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('not found')
    })
  })

  it('view_document on a non-existent docId → SAME 404 shape (anti-enumeration)', async () => {
    const stranger = await createUser()
    const { plaintext } = await mintPat({ userId: stranger.id, scopes: READ_SCOPES })

    const res = await mcp(plaintext).call('view_document', { doc_id: 'phantom-xy12' })
    expect(res.isError).toBe(true)
    expect(res.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('not found')
    })
  })

  it('replace_text on another user\'s private doc → 404 isError', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
    const stranger = await createUser()
    const { plaintext } = await mintPat({ userId: stranger.id, scopes: WRITE_SCOPES })

    const res = await mcp(plaintext).call('replace_text', {
      doc_id: doc.docId, old_str: 'a', new_str: 'b'
    })
    expect(res.isError).toBe(true)
    expect(res.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('not found')
    })
  })
})

describe('MCP authz — workspace role boundaries', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('workspace VIEWER can list workspace docs (member access works)', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const viewer = await createUser()
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
    await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId })
    const { plaintext } = await mintPat({ userId: viewer.id, scopes: READ_SCOPES })

    const res = await mcp(plaintext).call('list_workspace_documents', {
      workspace_id: ws.workspaceId
    })
    expect(res.isError).not.toBe(true)
  })

  it('non-member workspace_id → 404-shape (anti-enumeration; same as no-such-workspace)', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const stranger = await createUser()
    const { plaintext } = await mintPat({ userId: stranger.id, scopes: READ_SCOPES })

    const res = await mcp(plaintext).call('list_workspace_documents', {
      workspace_id: ws.workspaceId
    })
    expect(res.isError).toBe(true)
    expect(res.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('not found')
    })
  })

  it('non-existent workspace_id → SAME 404 shape (anti-enumeration)', async () => {
    const stranger = await createUser()
    const { plaintext } = await mintPat({ userId: stranger.id, scopes: READ_SCOPES })

    const res = await mcp(plaintext).call('list_workspace_documents', {
      workspace_id: 'ws-does-not-exist'
    })
    expect(res.isError).toBe(true)
    expect(res.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('not found')
    })
  })

  it('search_knowledge requires workspace MEMBERSHIP, not just the scope', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const stranger = await createUser()
    const { plaintext } = await mintPat({ userId: stranger.id, scopes: KNOWLEDGE_SCOPES })

    const res = await mcp(plaintext).call('search_knowledge', {
      workspace_id: ws.workspaceId,
      query: 'anything'
    })
    expect(res.isError).toBe(true)
    expect(res.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('not found')
    })
  })
})

describe('MCP authz — workspace owner can\'t bypass workspace gating', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('workspace owner cannot view a non-workspace doc owned by another user', async () => {
    // The PAT user owns workspace A. Another user has a private STANDALONE
    // doc (no workspace). A's workspace ownership doesn't grant them
    // access to that doc.
    const wsOwner = await createUser()
    await createWorkspace(wsOwner.id)
    const otherUser = await createUser()
    const otherDoc = await createDoc({ ownerId: otherUser.id, accessMode: 'private' })

    const { plaintext } = await mintPat({ userId: wsOwner.id, scopes: READ_SCOPES })
    const res = await mcp(plaintext).call('view_document', { doc_id: otherDoc.docId })
    expect(res.isError).toBe(true)
    expect(res.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('not found')
    })
  })
})

describe('MCP authz — workspace EDITOR can write through doc-bound tools', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('workspace editor can replace_text on a workspace doc owned by the admin', async () => {
    const admin = await createUser()
    const editor = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    const doc = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId, accessMode: 'private' })

    // Pre-seed content so replace_text has something to match.
    await import('yjs').then(async (Y) => {
      const ydoc = new Y.Doc()
      ydoc.getText('content').insert(0, 'editor will replace this')
      const update = Y.encodeStateAsUpdate(ydoc)
      const { testDb } = await import('../setup/db')
      await testDb().query(
        `INSERT INTO yjs_updates (doc_id, kind, data) VALUES ($1, 'update', $2)`,
        [doc.docId, Buffer.from(update)]
      )
    })

    const { plaintext } = await mintPat({ userId: editor.id, scopes: WRITE_SCOPES })
    const res = await mcp(plaintext).call('replace_text', {
      doc_id: doc.docId, old_str: 'replace this', new_str: 'WAS REPLACED'
    })
    expect(res.isError).not.toBe(true)
  }, 15_000)

  it('workspace VIEWER cannot replace_text (write-access required)', async () => {
    const admin = await createUser()
    const viewer = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
    const doc = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId, accessMode: 'private' })

    const { plaintext } = await mintPat({ userId: viewer.id, scopes: WRITE_SCOPES })
    const res = await mcp(plaintext).call('replace_text', {
      doc_id: doc.docId, old_str: 'a', new_str: 'b'
    })
    expect(res.isError).toBe(true)
    expect(res.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('not found')
    })
  })
})
