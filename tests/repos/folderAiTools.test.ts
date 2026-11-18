import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import { createDoc, createUser, createWorkspace, setMemberRole } from '../integration/setup/fixtures'
import { createFolder, moveDocToFolder } from '../../server/repos/folders'
import { upsertDocumentSearch } from '../../server/repos/documentSearch'
import { __mintWorkspaceAccess, __userActor } from '../../server/repos/proofs/testing'
import { asUser, docAs } from '../helpers/access'
import type { MetaToolContext } from '../../server/utils/agentic/toolContext'
import type { ToolDefinition } from '../../server/utils/ai/tools/toolDefinition'
import { createFolderTool, explorerErrorAsToolResult, listFoldersTool, moveDocumentTool } from '../../server/utils/ai/tools/folderTools'
import { listMyDocumentsTool, listWorkspaceDocumentsTool, searchDocumentsTool } from '../../server/utils/ai/tools/crossDocumentTools'

// The folder and document-list tools of the AI loop and MCP against the test
// database: they act with the initiator's rights in the explorer (workspace
// role, personal scope), page and search through the explorer's own code, and
// turn the explorer's refusals into tool errors the model can read.

type Ctx = MetaToolContext

function ctxFor(userId: number, opts: { workspaceId?: string, role?: 'admin' | 'editor' | 'viewer', docId?: string } = {}): Ctx {
  const workspaceAccess = opts.workspaceId
    ? __mintWorkspaceAccess(__userActor(userId), opts.workspaceId, opts.role ?? 'editor', 'member')
    : null
  return {
    docId: opts.docId ?? 'no-doc',
    initiatorUserId: userId,
    workspaceId: opts.workspaceId ?? null,
    self: asUser(userId),
    docAccess: null,
    workspaceAccess,
    sessionId: 'test-session',
    updateStatus: () => {}
  } as unknown as Ctx
}

async function call(tool: ToolDefinition<string, 'meta'>, ctx: Ctx, args: unknown) {
  const parsed = tool.schema.parse(args)
  const res = await tool.run(ctx, parsed)
  return { ...res, json: () => JSON.parse(res.content) as Record<string, unknown> }
}

async function folderOf(docId: string): Promise<string | null> {
  return (await testDb().query<{ folder_id: string | null }>('SELECT folder_id FROM documents WHERE doc_id = $1', [docId])).rows[0]?.folder_id ?? null
}

describe('list_folders / create_folder', () => {
  beforeEach(resetDb)

  it('lists the workspace tree with paths and document counts', async () => {
    const alice = await createUser()
    const ws = await createWorkspace(alice.id)
    const scope = __mintWorkspaceAccess(__userActor(alice.id), ws.workspaceId, 'admin', 'editor')
    await createFolder(scope, { folderId: 'proj', name: 'Projects', parentId: null })
    await createFolder(scope, { folderId: 'q3', name: 'Q3', parentId: 'proj' })
    const filed = await createDoc({ ownerId: alice.id, workspaceId: ws.workspaceId })
    await moveDocToFolder(docAs(filed.docId), 'q3')

    const res = await call(listFoldersTool, ctxFor(alice.id, { workspaceId: ws.workspaceId }), {})
    expect(res.isError).toBe(false)
    const body = res.json() as { scope: string, total: number, folders: Array<{ folder_id: string, path: string, documents: number }> }
    expect(body.scope).toBe('workspace')
    expect(body.total).toBe(2)
    expect(body.folders.find(f => f.folder_id === 'q3')).toMatchObject({ path: 'Projects / Q3', documents: 1 })
  })

  it('refuses a workspace the caller is not a member of, and lists personal folders on request', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const ws = await createWorkspace(alice.id)
    await createFolder(asUser(bob.id), { folderId: 'mine', name: 'Mine', parentId: null })

    const refused = await call(listFoldersTool, ctxFor(bob.id), { workspace_id: ws.workspaceId })
    expect(refused.isError).toBe(true)
    expect(refused.content).toContain('not a member')

    const personal = await call(listFoldersTool, ctxFor(bob.id), { workspace_id: 'personal' })
    expect((personal.json() as { scope: string, folders: Array<{ path: string }> }).folders.map(f => f.path)).toEqual(['Mine'])
  })

  it('creates folders at the top and inside a parent, and refuses a viewer', async () => {
    const alice = await createUser()
    const viewer = await createUser()
    const ws = await createWorkspace(alice.id)
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')

    const top = await call(createFolderTool, ctxFor(alice.id, { workspaceId: ws.workspaceId }), { name: 'Research' })
    expect(top.isError).toBe(false)
    const topId = (top.json() as { folder_id: string }).folder_id
    const child = await call(createFolderTool, ctxFor(alice.id), { name: 'Papers', parent_id: topId })
    expect(child.json()).toMatchObject({ path: 'Research / Papers', parent_id: topId, workspace_id: ws.workspaceId })

    // The parent's scope must match an explicit workspace_id.
    const mismatch = await call(createFolderTool, ctxFor(alice.id), { name: 'X', parent_id: topId, workspace_id: 'personal' })
    expect(mismatch.isError).toBe(true)

    // A sibling with the same name (any case) is the explorer's refusal, as a tool error.
    const dup = await call(createFolderTool, ctxFor(alice.id, { workspaceId: ws.workspaceId }), { name: 'research' })
    expect(dup.isError).toBe(true)
    expect(dup.content).toMatch(/^Error: /)

    const asViewer = await call(createFolderTool, ctxFor(viewer.id, { workspaceId: ws.workspaceId, role: 'viewer' }), { name: 'Nope' })
    expect(asViewer.isError).toBe(true)
    expect(asViewer.content).toContain('editor or admin')
  })
})

describe('move_document', () => {
  beforeEach(resetDb)

  it('files a document into a folder and back to the top level', async () => {
    const alice = await createUser()
    const ws = await createWorkspace(alice.id)
    const scope = __mintWorkspaceAccess(__userActor(alice.id), ws.workspaceId, 'admin', 'editor')
    await createFolder(scope, { folderId: 'arch', name: 'Archive', parentId: null })
    const doc = await createDoc({ ownerId: alice.id, workspaceId: ws.workspaceId })

    const moved = await call(moveDocumentTool, ctxFor(alice.id), { doc_id: `https://markoto.app/d/${doc.docId}`, folder_id: 'arch' })
    expect(moved.json()).toMatchObject({ doc_id: doc.docId, folder: 'Archive' })
    expect(await folderOf(doc.docId)).toBe('arch')

    const back = await call(moveDocumentTool, ctxFor(alice.id), { doc_id: doc.docId, folder_id: null })
    expect(back.json()).toMatchObject({ folder: '(top level)' })
    expect(await folderOf(doc.docId)).toBeNull()
  })

  it('explains each refusal: bad id, no edit rights, folder of another scope', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const ws = await createWorkspace(alice.id)
    await createFolder(asUser(bob.id), { folderId: 'bobs', name: 'Bobs', parentId: null })
    const doc = await createDoc({ ownerId: alice.id, workspaceId: ws.workspaceId })

    expect((await call(moveDocumentTool, ctxFor(alice.id), { doc_id: 'https://example.com/x y', folder_id: null })).content).toContain('could not extract')
    expect((await call(moveDocumentTool, ctxFor(bob.id), { doc_id: doc.docId, folder_id: null })).content).toContain('can\'t edit it')
    expect((await call(moveDocumentTool, ctxFor(alice.id), { doc_id: doc.docId, folder_id: 'bobs' })).content).toContain('folder doesn\'t exist')
    expect(await folderOf(doc.docId)).toBeNull()
  })
})

describe('list and search documents', () => {
  beforeEach(resetDb)

  it('pages a workspace with a cursor and marks the current document', async () => {
    const alice = await createUser()
    const ws = await createWorkspace(alice.id)
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push((await createDoc({ ownerId: alice.id, workspaceId: ws.workspaceId, title: `Doc ${i}` })).docId)
    const ctx = ctxFor(alice.id, { workspaceId: ws.workspaceId, docId: ids[0] })

    const first = (await call(listWorkspaceDocumentsTool, ctx, { limit: 3 })).json() as { total: number, documents: Array<{ doc_id: string, current_document?: boolean }>, next_cursor: string | null }
    expect(first.total).toBe(5)
    expect(first.documents).toHaveLength(3)
    expect(first.next_cursor).not.toBeNull()
    const second = (await call(listWorkspaceDocumentsTool, ctx, { limit: 3, cursor: first.next_cursor })).json() as typeof first
    expect(second.next_cursor).toBeNull()
    const all = [...first.documents, ...second.documents]
    expect(all.map(d => d.doc_id).toSorted()).toEqual(ids.toSorted())
    expect(all.filter(d => d.current_document).map(d => d.doc_id)).toEqual([ids[0]])

    // A malformed cursor is the explorer's 400, as a tool error.
    expect((await call(listWorkspaceDocumentsTool, ctx, { cursor: 'not-a-cursor' })).isError).toBe(true)
    // Outside a workspace there is no workspace list.
    expect((await call(listWorkspaceDocumentsTool, ctxFor(alice.id), {})).isError).toBe(true)
  })

  it('lists personal documents only, with their folder path', async () => {
    const alice = await createUser()
    const ws = await createWorkspace(alice.id)
    await createFolder(asUser(alice.id), { folderId: 'notes', name: 'Notes', parentId: null })
    const mine = await createDoc({ ownerId: alice.id, title: 'Personal', description: 'x'.repeat(400) })
    await moveDocToFolder(docAs(mine.docId), 'notes')
    await createDoc({ ownerId: alice.id, workspaceId: ws.workspaceId, title: 'In workspace' })

    const body = (await call(listMyDocumentsTool, ctxFor(alice.id), {})).json() as { documents: Array<{ doc_id: string, folder: string, description: string }> }
    expect(body.documents.map(d => d.doc_id)).toEqual([mine.docId])
    expect(body.documents[0]!.folder).toBe('Notes')
    expect(body.documents[0]!.description.length).toBe(160)
  })

  it('searches what the caller can open, narrowed by workspace or folder', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const ws = await createWorkspace(alice.id)
    const scope = __mintWorkspaceAccess(__userActor(alice.id), ws.workspaceId, 'admin', 'editor')
    await createFolder(scope, { folderId: 'fin', name: 'Finance', parentId: null })
    const inFolder = await createDoc({ ownerId: alice.id, workspaceId: ws.workspaceId, title: 'Budget 2026' })
    await moveDocToFolder(docAs(inFolder.docId), 'fin')
    const personal = await createDoc({ ownerId: alice.id, title: 'Home budget' })
    const bobs = await createDoc({ ownerId: bob.id, title: 'Bob budget' })
    for (const [d, title] of [[inFolder, 'Budget 2026'], [personal, 'Home budget'], [bobs, 'Bob budget']] as const) {
      await upsertDocumentSearch(docAs(d.docId), { title, body: 'the yearly budget plan', yjsId: 1, wordCount: 4, sizeBytes: 22 })
    }

    const everything = (await call(searchDocumentsTool, ctxFor(alice.id), { query: 'budg' })).json() as { results: Array<{ doc_id: string, folder: string | null, snippet: string, workspace: unknown }> }
    expect(everything.results.map(r => r.doc_id).toSorted()).toEqual([inFolder.docId, personal.docId].toSorted())
    const hit = everything.results.find(r => r.doc_id === inFolder.docId)!
    expect(hit.folder).toBe('Finance')
    expect(hit.workspace).toMatchObject({ id: ws.workspaceId })
    expect(everything.results.some(r => r.snippet.includes('**'))).toBe(true)

    const onlyPersonal = (await call(searchDocumentsTool, ctxFor(alice.id), { query: 'budget', workspace_id: 'personal' })).json() as typeof everything
    expect(onlyPersonal.results.map(r => r.doc_id)).toEqual([personal.docId])

    const byFolder = (await call(searchDocumentsTool, ctxFor(alice.id), { query: 'budget', folder_id: 'fin' })).json() as typeof everything
    expect(byFolder.results.map(r => r.doc_id)).toEqual([inFolder.docId])

    expect((await call(searchDocumentsTool, ctxFor(alice.id), { query: 'budget', folder_id: 'nope' })).content).toContain('not found')
    const none = await call(searchDocumentsTool, ctxFor(alice.id), { query: 'zebra' })
    expect(none.isError).toBe(false)
    expect(none.content).toContain('No documents match')
  })
})

describe('explorerErrorAsToolResult', () => {
  it('turns a 4xx into a tool error and lets anything else through', () => {
    const e = Object.assign(new Error('Folder not found'), { statusCode: 404 })
    expect(explorerErrorAsToolResult(e)).toEqual({ content: 'Error: Folder not found', isError: true })
    const bug = Object.assign(new Error('boom'), { statusCode: 500 })
    expect(() => explorerErrorAsToolResult(bug)).toThrow('boom')
  })
})
