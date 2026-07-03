import { describe, it, expect, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { resetDb, testDb } from '../setup/db'
import { createDoc, createUser, createWorkspace } from '../setup/fixtures'
import { mcp, mintPat } from '../setup/mcpClient'

// Host-style MCP tools (Phase 4):
//   - create_document    — new doc owned by the PAT user
//   - duplicate_document — clone of a viewable doc
//   - export_document_as_markdown — read raw ytext
//   - export_document_as_pdf      — render PDF, return as embedded resource
//
// All four must work end-to-end through the real stack (Nuxt + sync-test
// + renderer-test). The ymeta seed for create_document goes through
// Hocuspocus via the AI loop's existing trustedCommentClient — verifying
// the seed lands tests the create + connect chain in one shot.

async function readDocRow(docId: string): Promise<{
  owner_id: number | null
  workspace_id: string | null
  title: string
  access_mode: string
} | null> {
  const r = await testDb().query<{
    owner_id: number | null
    workspace_id: string | null
    title: string
    access_mode: string
  }>(
    `SELECT owner_id, workspace_id, title, access_mode FROM documents WHERE doc_id = $1`,
    [docId]
  )
  return r.rows[0] ?? null
}

const READ_SCOPES = ['documents:read'] as const
const WRITE_SCOPES = ['documents:read', 'documents:write'] as const

function parseDocIdFromCreate(text: string): string {
  // The handler returns JSON like `{"doc_id": "abc123XYZ_", "url": "/d/..."}`.
  const parsed = JSON.parse(text) as { doc_id?: string }
  if (!parsed.doc_id || !/^[A-Za-z0-9_-]{10}$/.test(parsed.doc_id)) {
    throw new Error(`create_document response did not include a valid doc_id: ${text}`)
  }
  return parsed.doc_id
}

describe('MCP host tools — create_document', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('creates a private doc owned by the PAT user (no workspace)', async () => {
    const user = await createUser()
    const { plaintext } = await mintPat({ userId: user.id, scopes: WRITE_SCOPES })

    const text = await mcp(plaintext).callText('create_document', {
      title: 'My new MCP doc'
    })
    const docId = parseDocIdFromCreate(text)

    const row = await readDocRow(docId)
    expect(row?.owner_id).toBe(user.id)
    expect(row?.workspace_id).toBeNull()
    expect(row?.access_mode).toBe('private')
    expect(row?.title).toBe('My new MCP doc')
  })

  it('files into a workspace when the user is admin/editor', async () => {
    const user = await createUser()
    const ws = await createWorkspace(user.id)
    const { plaintext } = await mintPat({ userId: user.id, scopes: WRITE_SCOPES })

    const text = await mcp(plaintext).callText('create_document', {
      title: 'Q3 retro',
      workspace_id: ws.workspaceId
    })
    const docId = parseDocIdFromCreate(text)

    const row = await readDocRow(docId)
    expect(row?.workspace_id).toBe(ws.workspaceId)
  })

  it('rejects workspace_id when the user is a non-member (403-shape)', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const stranger = await createUser()
    const { plaintext } = await mintPat({ userId: stranger.id, scopes: WRITE_SCOPES })

    const res = await mcp(plaintext).call('create_document', {
      title: 'sneaky',
      workspace_id: ws.workspaceId
    })
    expect(res.isError).toBe(true)
    expect(res.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringMatching(/member|forbidden|not allowed|not a/i)
    })
  })

  it('seeds initial_markdown into the new doc\'s ytext', async () => {
    // Verify the seed via export_document_as_markdown rather than
    // by replaying yjs_documents binary directly — tests the same
    // path a real MCP client would use to read the doc back, and
    // dodges the y-postgresql update-encoding gotcha (rows aren't
    // self-contained Y.js updates; they're chunks the persistence
    // layer concatenates internally).
    const user = await createUser()
    const client = mcp((await mintPat({ userId: user.id, scopes: WRITE_SCOPES })).plaintext)

    const createText = await client.callText('create_document', {
      title: 'Seeded',
      initial_markdown: '# Title from MCP\n\nBody paragraph.'
    })
    const docId = parseDocIdFromCreate(createText)

    // Wait for the Hocuspocus debounce window — the seed is written
    // by openTrustedCommentClient which transacts on a fresh Y.Doc;
    // sync-server debounces 2-10s before flushing to yjs_documents
    // and broadcasting to other connections.
    await new Promise(r => setTimeout(r, 12_000))

    const exported = await client.callText('export_document_as_markdown', { doc_id: docId })
    expect(exported).toContain('# Title from MCP')
    expect(exported).toContain('Body paragraph.')
  }, 30_000)
})

describe('MCP host tools — duplicate_document', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('clones a doc the user can view', async () => {
    const user = await createUser()
    const source = await createDoc({ ownerId: user.id, title: 'Original' })

    const { plaintext } = await mintPat({ userId: user.id, scopes: WRITE_SCOPES })
    const text = await mcp(plaintext).callText('duplicate_document', {
      source_doc_id: source.docId
    })

    // Response shape: JSON with the new doc_id.
    const parsed = JSON.parse(text) as { doc_id?: string }
    expect(parsed.doc_id).toBeTruthy()
    expect(parsed.doc_id).not.toBe(source.docId)

    const row = await readDocRow(parsed.doc_id!)
    expect(row?.owner_id).toBe(user.id)
    expect(row?.title).toMatch(/Original/) // typically "Copy of Original" or the title verbatim
  })

  it('rejects source_doc_id the user cannot view (404 anti-enumeration)', async () => {
    const owner = await createUser()
    const source = await createDoc({ ownerId: owner.id, title: 'Private' })
    const stranger = await createUser()
    const { plaintext } = await mintPat({ userId: stranger.id, scopes: WRITE_SCOPES })

    const res = await mcp(plaintext).call('duplicate_document', {
      source_doc_id: source.docId
    })
    expect(res.isError).toBe(true)
    expect(res.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringMatching(/not found/i)
    })
  })
})

describe('MCP host tools — export_document_as_markdown', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns the doc\'s raw markdown content', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })
    // Seed via direct DB insert so we don't need a Hocuspocus write to
    // populate state — export reads through YDocPool which loads from
    // yjs_documents on connect.
    const ydoc = new Y.Doc()
    ydoc.getText('content').insert(0, '# Exported title\n\nBody text here.')
    const update = Y.encodeStateAsUpdate(ydoc)
    await testDb().query(
      `INSERT INTO yjs_documents (docname, value, version) VALUES ($1, $2, 'v1')`,
      [doc.docId, Buffer.from(update)]
    )

    const { plaintext } = await mintPat({ userId: user.id, scopes: READ_SCOPES })
    const text = await mcp(plaintext).callText('export_document_as_markdown', { doc_id: doc.docId })

    expect(text).toContain('# Exported title')
    expect(text).toContain('Body text here.')
  })
})

describe('MCP host tools — export_document_as_pdf', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('renders to PDF and returns an embedded resource block', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id, title: 'PDF source' })
    // Renderer needs non-empty content to paginate to ≥1 page.
    const ydoc = new Y.Doc()
    ydoc.getText('content').insert(0, '# Hello\n\n' + 'Lorem ipsum dolor sit amet. '.repeat(40))
    const update = Y.encodeStateAsUpdate(ydoc)
    await testDb().query(
      `INSERT INTO yjs_documents (docname, value, version) VALUES ($1, $2, 'v1')`,
      [doc.docId, Buffer.from(update)]
    )

    const { plaintext } = await mintPat({ userId: user.id, scopes: READ_SCOPES })
    const res = await mcp(plaintext).call('export_document_as_pdf', { doc_id: doc.docId })

    if (res.isError) {
      const errText = res.content.find(c => c.type === 'text')?.text ?? '(no text)'
      throw new Error(`export_document_as_pdf returned isError: ${errText}`)
    }

    // Two content blocks: a status text + an embedded resource holding
    // the PDF blob (base64).
    const resourceBlock = res.content.find(c => c.type === 'resource')
    expect(resourceBlock).toBeDefined()
    if (!resourceBlock || resourceBlock.type !== 'resource') throw new Error('unreachable')

    expect(resourceBlock.resource.mimeType).toBe('application/pdf')
    expect(resourceBlock.resource.uri).toMatch(/^doc:\/\/\//)
    expect(resourceBlock.resource.blob).toBeTruthy()
    // PDF magic bytes — base64 of "%PDF" is "JVBERi0".
    expect(resourceBlock.resource.blob).toMatch(/^JVBERi0/)
  }, 60_000) // renderer cold-start can take 5-15s
})
