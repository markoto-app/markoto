import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { createDoc, createUser, createWorkspace, setMemberRole } from '../setup/fixtures'
import { mcp, mintPat } from '../setup/mcpClient'

// The explorer tools over MCP: document search, folder listing, filing a
// document, creating a folder, and the paged document lists. They run the
// explorer's own decisions, so the permissions are the document list's:
// a non-member sees nothing of a workspace, a viewer reads but cannot file
// or create, and refusals look like "not found". Read-only plans
// (`mcpWrite` off) are pinned in tests/unit/mcp/mcpPlanGate.test.ts.

const READ = ['documents:read'] as const
const WRITE = ['documents:read', 'documents:write'] as const

async function index(docId: string, title: string, body: string): Promise<void> {
  await testDb().query(`INSERT INTO document_search (doc_id, title, body) VALUES ($1, $2, $3)`, [docId, title, body])
}

async function folder(input: { folderId: string, name: string, workspaceId?: string, ownerId?: number, parentId?: string }): Promise<string> {
  await testDb().query(
    `INSERT INTO folders (folder_id, workspace_id, owner_id, parent_id, name) VALUES ($1, $2, $3, $4, $5)`,
    [input.folderId, input.workspaceId ?? null, input.workspaceId ? null : input.ownerId ?? null, input.parentId ?? null, input.name]
  )
  return input.folderId
}

async function folderOf(docId: string): Promise<string | null> {
  const r = await testDb().query<{ folder_id: string | null }>('SELECT folder_id FROM documents WHERE doc_id = $1', [docId])
  return r.rows[0]?.folder_id ?? null
}

async function json<T>(token: string, tool: string, args: Record<string, unknown>): Promise<T> {
  return JSON.parse(await mcp(token).callText(tool, args)) as T
}

describe('MCP explorer tools: search_documents', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('finds personal and workspace documents with workspace, folder path and a marked snippet', async () => {
    const user = await createUser()
    const ws = await createWorkspace(user.id, { name: 'Engineering' })
    const specs = await folder({ folderId: 'f-specs', name: 'Specs', workspaceId: ws.workspaceId })
    const inWs = await createDoc({ ownerId: user.id, workspaceId: ws.workspaceId, title: 'Payment retro' })
    await testDb().query('UPDATE documents SET folder_id = $1 WHERE doc_id = $2', [specs, inWs.docId])
    const personal = await createDoc({ ownerId: user.id, title: 'My retro notes' })
    await index(inWs.docId, 'Payment retro', 'The retro found three gaps.')
    await index(personal.docId, 'My retro notes', 'Retro thoughts.')

    const { plaintext } = await mintPat({ userId: user.id, scopes: READ })
    const out = await json<{ results: Array<{ doc_id: string, workspace: { id: string, name: string } | null, folder: string | null, snippet: string }> }>(plaintext, 'search_documents', { query: 'retro' })

    const ws1 = out.results.find(r => r.doc_id === inWs.docId)
    expect(ws1).toMatchObject({ workspace: { id: ws.workspaceId, name: 'Engineering' }, folder: 'Specs' })
    expect(ws1?.snippet).toContain('**')
    expect(out.results.find(r => r.doc_id === personal.docId)).toMatchObject({ workspace: null, folder: null })
  })

  it('a non-member gets nothing from the workspace, and naming it answers "not found"', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const doc = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId, title: 'Secret plan' })
    await index(doc.docId, 'Secret plan', 'secret')
    const stranger = await createUser()

    const { plaintext } = await mintPat({ userId: stranger.id, scopes: READ })
    const everywhere = await mcp(plaintext).callText('search_documents', { query: 'secret' })
    expect(everywhere).not.toContain(doc.docId)
    const named = await mcp(plaintext).call('search_documents', { query: 'secret', workspace_id: ws.workspaceId })
    expect(named.isError).toBe(true)
    expect(JSON.stringify(named.content)).not.toContain(doc.docId)
  })

  it('a folder of another workspace is "not found"', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const theirs = await folder({ folderId: 'f-theirs', name: 'Theirs', workspaceId: ws.workspaceId })
    const stranger = await createUser()
    const { plaintext } = await mintPat({ userId: stranger.id, scopes: READ })
    const res = await mcp(plaintext).call('search_documents', { query: 'x', folder_id: theirs })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toContain('not found')
  })
})

describe('MCP explorer tools: list_folders', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('a viewer lists the workspace folders with full paths; a non-member gets "not found"', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    await folder({ folderId: 'f-a', name: 'Projects', workspaceId: ws.workspaceId })
    await folder({ folderId: 'f-b', name: '2026', workspaceId: ws.workspaceId, parentId: 'f-a' })
    const viewer = await createUser()
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')

    const v = await mintPat({ userId: viewer.id, scopes: READ })
    const out = await json<{ folders: Array<{ folder_id: string, path: string }> }>(v.plaintext, 'list_folders', { workspace_id: ws.workspaceId })
    expect(out.folders.find(f => f.folder_id === 'f-b')?.path).toBe('Projects / 2026')

    const stranger = await createUser()
    const s = await mintPat({ userId: stranger.id, scopes: READ })
    const res = await mcp(s.plaintext).call('list_folders', { workspace_id: ws.workspaceId })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).not.toContain('Projects')
  })

  it('without a workspace lists only the caller\'s personal folders', async () => {
    const user = await createUser()
    const other = await createUser()
    await folder({ folderId: 'f-mine', name: 'Mine', ownerId: user.id })
    await folder({ folderId: 'f-other', name: 'NotMine', ownerId: other.id })
    const { plaintext } = await mintPat({ userId: user.id, scopes: READ })
    const text = await mcp(plaintext).callText('list_folders', {})
    expect(text).toContain('f-mine')
    expect(text).not.toContain('f-other')
  })
})

describe('MCP explorer tools: move_document', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('an editor files a workspace document into a folder and back to the top level', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const target = await folder({ folderId: 'f-t', name: 'Target', workspaceId: ws.workspaceId })
    const doc = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId })
    const editor = await createUser()
    await setMemberRole(ws.workspaceId, editor.id, 'editor')

    const { plaintext } = await mintPat({ userId: editor.id, scopes: WRITE })
    const out = await json<{ folder: string }>(plaintext, 'move_document', { doc_id: doc.docId, folder_id: target })
    expect(out.folder).toBe('Target')
    expect(await folderOf(doc.docId)).toBe(target)

    await mcp(plaintext).callText('move_document', { doc_id: doc.docId, folder_id: null })
    expect(await folderOf(doc.docId)).toBe(null)
  })

  it('a viewer cannot move, and a stranger gets the same "not found"', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const target = await folder({ folderId: 'f-t', name: 'Target', workspaceId: ws.workspaceId })
    const doc = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId })
    const viewer = await createUser()
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
    const stranger = await createUser()

    for (const user of [viewer, stranger]) {
      const { plaintext } = await mintPat({ userId: user.id, scopes: WRITE })
      const res = await mcp(plaintext).call('move_document', { doc_id: doc.docId, folder_id: target })
      expect(res.isError).toBe(true)
      expect(JSON.stringify(res.content)).toContain('not found')
    }
    expect(await folderOf(doc.docId)).toBe(null)
  })

  it('refuses a folder of another workspace', async () => {
    const user = await createUser()
    const wsA = await createWorkspace(user.id)
    const wsB = await createWorkspace(user.id)
    const elsewhere = await folder({ folderId: 'f-b', name: 'B', workspaceId: wsB.workspaceId })
    const doc = await createDoc({ ownerId: user.id, workspaceId: wsA.workspaceId })
    const { plaintext } = await mintPat({ userId: user.id, scopes: WRITE })
    const res = await mcp(plaintext).call('move_document', { doc_id: doc.docId, folder_id: elsewhere })
    expect(res.isError).toBe(true)
    expect(await folderOf(doc.docId)).toBe(null)
  })
})

describe('MCP explorer tools: create_folder and create_document', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('an editor creates a nested folder and files a new document into it', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const editor = await createUser()
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    const { plaintext } = await mintPat({ userId: editor.id, scopes: WRITE })

    const parent = await json<{ folder_id: string }>(plaintext, 'create_folder', { workspace_id: ws.workspaceId, name: 'Projects' })
    const child = await json<{ folder_id: string, path: string, workspace_id: string }>(plaintext, 'create_folder', { name: 'Q3', parent_id: parent.folder_id })
    expect(child).toMatchObject({ path: 'Projects / Q3', workspace_id: ws.workspaceId })

    // folder_id alone files into the folder's own workspace.
    const created = await json<{ doc_id: string }>(plaintext, 'create_document', { title: 'Plan', folder_id: child.folder_id })
    const row = await testDb().query<{ workspace_id: string, folder_id: string }>('SELECT workspace_id, folder_id FROM documents WHERE doc_id = $1', [created.doc_id])
    expect(row.rows[0]).toEqual({ workspace_id: ws.workspaceId, folder_id: child.folder_id })
  })

  it('a viewer cannot create folders; a duplicate name is a tool error', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const viewer = await createUser()
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')

    const v = await mintPat({ userId: viewer.id, scopes: WRITE })
    expect((await mcp(v.plaintext).call('create_folder', { workspace_id: ws.workspaceId, name: 'Nope' })).isError).toBe(true)
    const count = await testDb().query<{ n: number }>('SELECT count(*)::int AS n FROM folders')
    expect(count.rows[0]?.n).toBe(0)

    const o = await mintPat({ userId: owner.id, scopes: WRITE })
    await mcp(o.plaintext).callText('create_folder', { workspace_id: ws.workspaceId, name: 'Same' })
    expect((await mcp(o.plaintext).call('create_folder', { workspace_id: ws.workspaceId, name: 'same' })).isError).toBe(true)
  })
})

describe('MCP explorer tools: paged lists', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('list_workspace_documents pages with next_cursor until every document was seen', async () => {
    const user = await createUser()
    const ws = await createWorkspace(user.id)
    const ids = new Set<string>()
    for (let i = 0; i < 5; i++) ids.add((await createDoc({ ownerId: user.id, workspaceId: ws.workspaceId, title: `D${i}` })).docId)
    const { plaintext } = await mintPat({ userId: user.id, scopes: READ })

    const seen: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 5; page++) {
      const out = await json<{ total: number, documents: Array<{ doc_id: string }>, next_cursor: string | null }>(plaintext, 'list_workspace_documents', { workspace_id: ws.workspaceId, limit: 2, ...(cursor ? { cursor } : {}) })
      expect(out.total).toBe(5)
      seen.push(...out.documents.map(d => d.doc_id))
      if (!out.next_cursor) break
      cursor = out.next_cursor
    }
    expect(seen.sort()).toEqual([...ids].sort())
  })

  it('list_my_documents lists personal documents only', async () => {
    const user = await createUser()
    const ws = await createWorkspace(user.id)
    const personal = await createDoc({ ownerId: user.id, title: 'personal' })
    const inWs = await createDoc({ ownerId: user.id, workspaceId: ws.workspaceId, title: 'in-ws' })
    const { plaintext } = await mintPat({ userId: user.id, scopes: READ })
    const text = await mcp(plaintext).callText('list_my_documents', {})
    expect(text).toContain(personal.docId)
    expect(text).not.toContain(inWs.docId)
  })
})
