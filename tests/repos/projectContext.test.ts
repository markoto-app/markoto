import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import { createDoc, createUser, createWorkspace, setMemberRole } from '../integration/setup/fixtures'
import { addContextLink, getContextScope, listContextCandidates, listContextLinks, removeContextLink, setContextScope } from '../../server/repos/projectContext'
import { ConflictError } from '../../server/repos/errors'
import { listProjectContext, listReadableContextLinks, resolveProjectContext } from '../../server/utils/documents/projectContext'
import { docAs } from '../helpers/access'
import { MAX_CONTEXT_DOCS } from '../../shared/config/projectContext'

// Project context ("bible"): which marked documents apply to a document
// (scope-wide, the folder chain, attachments), and that every reader only
// receives the context documents they may open themselves. A guest never
// gets workspace context that was not shared with them.

async function folder(id: string, scope: { workspaceId?: string, ownerId?: number }, parentId: string | null = null): Promise<string> {
  await testDb().query(
    'INSERT INTO folders (folder_id, workspace_id, owner_id, parent_id, name) VALUES ($1, $2, $3, $4, $5)',
    [id, scope.workspaceId ?? null, scope.ownerId ?? null, parentId, id]
  )
  return id
}

async function file(docId: string, folderId: string | null): Promise<void> {
  await testDb().query('UPDATE documents SET folder_id = $2 WHERE doc_id = $1', [docId, folderId])
}

async function mark(docId: string, scope: 'folder' | 'all'): Promise<void> {
  await setContextScope(docAs(docId), scope)
}

async function index(docId: string, body: string): Promise<void> {
  await testDb().query(
    `INSERT INTO document_search (doc_id, title, body) SELECT doc_id, title, $2 FROM documents WHERE doc_id = $1
     ON CONFLICT (doc_id) DO UPDATE SET body = excluded.body`,
    [docId, body]
  )
}

async function share(docId: string, userId: number): Promise<void> {
  await testDb().query('INSERT INTO document_shares (doc_id, user_id, access) VALUES ($1, $2, \'view\')', [docId, userId])
}

const ids = (rows: Array<{ docId: string }>) => rows.map(r => r.docId)

describe('project context candidates (repo)', () => {
  beforeEach(resetDb)

  it('collects scope-wide documents, the folder chain from the root down, then attachments', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const scope = { workspaceId: ws.workspaceId }
    await folder('book', scope)
    await folder('part1', scope, 'book')
    await folder('ch1', scope, 'part1')
    await folder('other', scope)
    const target = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId, docId: 'target' })
    await file(target.docId, 'ch1')

    const style = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId, docId: 'style' })
    await file(style.docId, 'other')
    await mark(style.docId, 'all') // whole workspace, wherever it is filed
    const rootCtx = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId, docId: 'root-ctx' })
    await mark(rootCtx.docId, 'folder') // at the root: the whole workspace
    const bookCtx = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId, docId: 'book-ctx' })
    await file(bookCtx.docId, 'book')
    await mark(bookCtx.docId, 'folder')
    const chCtx = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId, docId: 'ch-ctx' })
    await file(chCtx.docId, 'ch1')
    await mark(chCtx.docId, 'folder')
    const unrelated = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId, docId: 'unrelated' })
    await file(unrelated.docId, 'other')
    await mark(unrelated.docId, 'folder') // another branch of the tree: not ours
    const plain = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId, docId: 'plain' })
    await file(plain.docId, 'ch1') // not marked
    const attached = await createDoc({ ownerId: owner.id, docId: 'attached' })
    await addContextLink(docAs(target.docId), docAs(attached.docId), owner.id, 10)

    const candidates = await listContextCandidates(docAs(target.docId), 40)
    expect(candidates.map(c => c.docId)).toEqual(['style', 'root-ctx', 'book-ctx', 'ch-ctx', 'attached'])
    expect(candidates.map(c => c.source)).toEqual(['all', 'folder', 'folder', 'folder', 'link'])
  })

  it('never names the document itself, nor documents of another workspace or another person\'s personal documents', async () => {
    const owner = await createUser()
    const other = await createUser()
    const ws = await createWorkspace(owner.id)
    const ws2 = await createWorkspace(owner.id)
    const target = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId })
    await mark(target.docId, 'all')
    const elsewhere = await createDoc({ ownerId: owner.id, workspaceId: ws2.workspaceId })
    await mark(elsewhere.docId, 'all')
    const personal = await createDoc({ ownerId: owner.id })
    await mark(personal.docId, 'all')
    const othersPersonal = await createDoc({ ownerId: other.id })
    await mark(othersPersonal.docId, 'all')
    expect(await listContextCandidates(docAs(target.docId), 40)).toEqual([])

    // Personal scope: the owner's own marked personal documents only.
    const mine = await createDoc({ ownerId: owner.id })
    expect((await listContextCandidates(docAs(mine.docId), 40)).map(c => c.docId)).toEqual([personal.docId])
  })

  it('attaches idempotently, caps attachments, refuses a document as its own context, detaches', async () => {
    const owner = await createUser()
    const a = await createDoc({ ownerId: owner.id })
    const b = await createDoc({ ownerId: owner.id })
    const c = await createDoc({ ownerId: owner.id })
    await addContextLink(docAs(a.docId), docAs(b.docId), owner.id, 1)
    await addContextLink(docAs(a.docId), docAs(b.docId), owner.id, 1)
    expect(await listContextLinks(docAs(a.docId))).toEqual([b.docId])
    await expect(addContextLink(docAs(a.docId), docAs(c.docId), owner.id, 1)).rejects.toBeInstanceOf(ConflictError)
    await expect(addContextLink(docAs(a.docId), docAs(a.docId), owner.id, 5)).rejects.toBeInstanceOf(ConflictError)
    expect(await removeContextLink(docAs(a.docId), b.docId)).toBe(true)
    expect(await removeContextLink(docAs(a.docId), b.docId)).toBe(false)
  })

  it('marks and unmarks; deleting either document removes the attachment', async () => {
    const owner = await createUser()
    const a = await createDoc({ ownerId: owner.id })
    const b = await createDoc({ ownerId: owner.id })
    await mark(a.docId, 'folder')
    expect(await getContextScope(docAs(a.docId))).toBe('folder')
    await setContextScope(docAs(a.docId), null)
    expect(await getContextScope(docAs(a.docId))).toBeNull()
    await addContextLink(docAs(a.docId), docAs(b.docId), owner.id, 10)
    await testDb().query('DELETE FROM documents WHERE doc_id = $1', [b.docId])
    expect(await listContextLinks(docAs(a.docId))).toEqual([])
  })

  it('bumps the explorer counter when a document is marked', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const doc = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId })
    const version = async () => Number((await testDb().query<{ v: string }>('SELECT explorer_version AS v FROM workspaces WHERE workspace_id = $1', [ws.workspaceId])).rows[0]?.v)
    const before = await version()
    await mark(doc.docId, 'all')
    expect(await version()).toBe(before + 1)
  })
})

describe('project context per reader (access)', () => {
  beforeEach(resetDb)

  async function workspaceWithBible() {
    const admin = await createUser({ name: 'Admin' })
    const editor = await createUser({ name: 'Editor' })
    const guest = await createUser({ name: 'Guest' })
    const outsider = await createUser({ name: 'Outsider' })
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    await setMemberRole(ws.workspaceId, guest.id, 'guest')
    const bible = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId, title: 'Bible', accessMode: 'private' })
    await mark(bible.docId, 'all')
    await index(bible.docId, '# Characters\nMara, 34, pilots the ferry.')
    const chapter = await createDoc({ ownerId: editor.id, workspaceId: ws.workspaceId, title: 'Chapter 1', accessMode: 'private' })
    return { admin, editor, guest, outsider, ws, bible, chapter }
  }

  it('members get the workspace context with its text', async () => {
    const { editor, bible, chapter } = await workspaceWithBible()
    const resolved = await resolveProjectContext(docAs(chapter.docId), editor.id)
    expect(resolved.entries.map(e => ({ docId: e.docId, title: e.title, source: e.source, body: e.body }))).toEqual([
      { docId: bible.docId, title: 'Bible', source: 'all', body: '# Characters\nMara, 34, pilots the ferry.' }
    ])
  })

  it('a guest with a share on the chapter does not get the private workspace bible', async () => {
    const { guest, chapter } = await workspaceWithBible()
    await share(chapter.docId, guest.id)
    expect(ids((await listProjectContext(docAs(chapter.docId), guest.id)).entries)).toEqual([])
  })

  it('a guest gets the bible once it is shared with them too', async () => {
    const { guest, bible, chapter } = await workspaceWithBible()
    await share(chapter.docId, guest.id)
    await share(bible.docId, guest.id)
    expect(ids((await listProjectContext(docAs(chapter.docId), guest.id)).entries)).toEqual([bible.docId])
  })

  it('a password-protected context document reaches members only', async () => {
    const { editor, outsider, chapter } = await workspaceWithBible()
    await testDb().query('UPDATE documents SET access_mode = \'open-edit\' WHERE doc_id = $1', [chapter.docId])
    const locked = await createDoc({ ownerId: editor.id, title: 'Locked', accessMode: 'password-protected', passwordHash: 'x' })
    await addContextLink(docAs(chapter.docId), docAs(locked.docId), editor.id, 10)
    expect(ids((await listProjectContext(docAs(chapter.docId), outsider.id)).entries)).toEqual([])
    const links = await listReadableContextLinks(docAs(chapter.docId), outsider.id)
    expect(links).toEqual({ links: [], hidden: 1 })
    expect(ids((await listProjectContext(docAs(chapter.docId), editor.id)).entries)).toContain(locked.docId)
  })

  it('an attachment never widens access: someone else\'s private document stays out', async () => {
    const { admin, outsider, chapter } = await workspaceWithBible()
    const secret = await createDoc({ ownerId: outsider.id, title: 'Secret', accessMode: 'private' })
    await addContextLink(docAs(chapter.docId), docAs(secret.docId), outsider.id, 10)
    expect(ids((await listProjectContext(docAs(chapter.docId), admin.id)).entries)).not.toContain(secret.docId)
  })

  it('caps the documents per prompt and counts the rest', async () => {
    const owner = await createUser()
    const target = await createDoc({ ownerId: owner.id })
    for (let i = 0; i < MAX_CONTEXT_DOCS + 2; i++) {
      const d = await createDoc({ ownerId: owner.id, title: `Ctx ${i}` })
      await mark(d.docId, 'all')
    }
    const resolved = await listProjectContext(docAs(target.docId), owner.id)
    expect(resolved.entries).toHaveLength(MAX_CONTEXT_DOCS)
    expect(resolved.omitted).toBe(2)
  })
})
