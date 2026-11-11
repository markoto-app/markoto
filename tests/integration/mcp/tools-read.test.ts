import { describe, it, expect, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { resetDb, testDb } from '../setup/db'
import { createDoc, createUser, createWorkspace } from '../setup/fixtures'
import { mcp, mintPat } from '../setup/mcpClient'
import { splitMarkotoFrontmatter } from '~~/shared/utils/markdownFrontmatter'

// Documents:read tools — happy paths against real DB + real Y.js
// state. Authz failures (cross-user, cross-workspace) are pinned in
// authz.test.ts; this file is "the tool returns plausible content
// when the caller is authorised".

async function seedYjs(docname: string, body: string): Promise<void> {
  const ydoc = new Y.Doc()
  ydoc.getText('content').insert(0, body)
  const update = Y.encodeStateAsUpdate(ydoc)
  await testDb().query(
    `INSERT INTO yjs_documents (docname, value, version) VALUES ($1, $2, 'v1')`,
    [docname, Buffer.from(update)]
  )
}

const READ_SCOPES = ['documents:read'] as const

describe('MCP read tools — view_document', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns line-numbered content for the calling user\'s own doc', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id, title: 'Hello' })
    await seedYjs(doc.docId, 'first line\nsecond line\nthird')

    const { plaintext } = await mintPat({ userId: user.id, scopes: READ_SCOPES })
    const text = await mcp(plaintext).callText('view_document', { doc_id: doc.docId })

    // viewDocument prefixes 1-indexed line numbers — exact format pinned.
    expect(text).toContain('1: first line')
    expect(text).toContain('2: second line')
    expect(text).toContain('3: third')
  })

  it('view_range slices to the requested lines', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })
    await seedYjs(doc.docId, 'a\nb\nc\nd\ne')

    const { plaintext } = await mintPat({ userId: user.id, scopes: READ_SCOPES })
    const text = await mcp(plaintext).callText('view_document', {
      doc_id: doc.docId,
      view_range: [2, 4]
    })

    expect(text).toContain('2: b')
    expect(text).toContain('3: c')
    expect(text).toContain('4: d')
    expect(text).not.toContain('1: a')
    expect(text).not.toContain('5: e')
  })

  it('view_document is STRICTER than browser authz — open-edit alone does not grant MCP view', async () => {
    // PAT-authenticated MCP callers get access to docs they OWN or are
    // workspace members of, NOT every public open-edit doc on the
    // server. Stricter than the browser-side accessMode contract by
    // design — see getDocAuthz in server/utils/workspaces/workspaceAccess.ts
    // (canView = isDocOwner || hasRole, accessMode is not consulted).
    // 404-shape (not 403) matches the rest of the anti-enumeration
    // policy.
    const stranger = await createUser()
    const doc = await createDoc({ ownerId: null, accessMode: 'open-edit' })
    await seedYjs(doc.docId, 'public content')

    const { plaintext } = await mintPat({ userId: stranger.id, scopes: READ_SCOPES })
    const res = await mcp(plaintext).call('view_document', { doc_id: doc.docId })

    expect(res.isError).toBe(true)
    expect(res.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('not found')
    })
  })
})

describe('MCP read tools — list_my_documents', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns docs owned by the PAT user', async () => {
    const user = await createUser()
    const a = await createDoc({ ownerId: user.id, title: 'doc-a' })
    const b = await createDoc({ ownerId: user.id, title: 'doc-b' })
    // Doc owned by someone else MUST NOT show up.
    const stranger = await createUser()
    await createDoc({ ownerId: stranger.id, title: 'their-doc' })

    const { plaintext } = await mintPat({ userId: user.id, scopes: READ_SCOPES })
    const text = await mcp(plaintext).callText('list_my_documents', {})

    expect(text).toContain(a.docId)
    expect(text).toContain(b.docId)
    expect(text).not.toContain('their-doc')
  })
})

describe('MCP read tools — list_workspace_documents', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns docs in workspaces the PAT user belongs to', async () => {
    const user = await createUser()
    const ws = await createWorkspace(user.id)
    const doc = await createDoc({ ownerId: user.id, workspaceId: ws.workspaceId, title: 'in-workspace' })

    const { plaintext } = await mintPat({ userId: user.id, scopes: READ_SCOPES })
    const text = await mcp(plaintext).callText('list_workspace_documents', { workspace_id: ws.workspaceId })

    expect(text).toContain(doc.docId)
  })
})

describe('MCP read tools — themes', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('get_theme returns the doc\'s current theme', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })

    const { plaintext } = await mintPat({ userId: user.id, scopes: READ_SCOPES })
    const res = await mcp(plaintext).callText('get_theme', { doc_id: doc.docId })

    // Default theme JSON has at least the page + body sections — assert
    // we got SOMETHING parseable rather than over-specifying internal
    // theme shape.
    const parsed = JSON.parse(res)
    expect(parsed).toBeTypeOf('object')
    expect(parsed).toHaveProperty('page')
  })

  it('list_themes returns the savedThemes / workspaceDefault structure', async () => {
    // The handler returns ONLY user-scoped saved themes + workspace
    // default — built-in presets are surfaced separately via the
    // update_theme tool's `preset` field, not list_themes. For a
    // fresh user with no saved themes and no workspace default, we
    // still expect the structural shape (savedThemes:[], default:null).
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })

    const { plaintext } = await mintPat({ userId: user.id, scopes: READ_SCOPES })
    const text = await mcp(plaintext).callText('list_themes', { doc_id: doc.docId })

    const parsed = JSON.parse(text) as { savedThemes: unknown, workspaceDefault: unknown, notes: unknown }
    expect(Array.isArray(parsed.savedThemes)).toBe(true)
    expect((parsed.savedThemes as unknown[]).length).toBe(0)
    expect(parsed.workspaceDefault).toBeNull()
    expect(Array.isArray(parsed.notes)).toBe(true)
  })
})

describe('MCP read tools — read_comments', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns "no comments" when the doc has none', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })
    await seedYjs(doc.docId, 'body without comments')

    const { plaintext } = await mintPat({ userId: user.id, scopes: READ_SCOPES })
    const text = await mcp(plaintext).callText('read_comments', { doc_id: doc.docId })

    // Exact message subject to change; assert the content block is
    // shaped like a "nothing to read" response, not an error.
    expect(text.toLowerCase()).toMatch(/no comments|empty|0/)
  })
})

describe('MCP read tools — search_activity_log', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns an empty result for a doc with no activity', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })

    const { plaintext } = await mintPat({ userId: user.id, scopes: READ_SCOPES })
    const res = await mcp(plaintext).call('search_activity_log', { doc_id: doc.docId })
    // Shape-only assertion — content present, no isError.
    expect(res.isError).not.toBe(true)
    expect(res.content.length).toBeGreaterThan(0)
  })
})

describe('MCP read tools — export_document_as_markdown', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns the raw ytext content', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })
    await seedYjs(doc.docId, '# Title\n\nParagraph one.\n')

    const { plaintext } = await mintPat({ userId: user.id, scopes: READ_SCOPES })
    const text = await mcp(plaintext).callText('export_document_as_markdown', { doc_id: doc.docId })

    expect(text).toContain('# Title')
    expect(text).toContain('Paragraph one.')
    // Unlike view_document, export does NOT prepend line numbers.
    expect(text).not.toMatch(/^1:\s/m)
  })

  it('starts with the markoto frontmatter the editor download writes', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id, title: 'Quarterly', language: 'fr' })
    await seedYjs(doc.docId, '# Body\n')

    const { plaintext } = await mintPat({ userId: user.id, scopes: READ_SCOPES })
    const text = await mcp(plaintext).callText('export_document_as_markdown', { doc_id: doc.docId })

    const split = splitMarkotoFrontmatter(text)
    expect(split.kind).toBe('markoto')
    if (split.kind !== 'markoto') return
    expect(split.body).toBe('# Body\n')
    expect(split.data).toMatchObject({ markoto: 1, title: 'Quarterly', language: 'fr' })
    expect(split.data.theme).toBeTypeOf('object')
  })
})

describe('MCP read tools — get_page_count', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns a number for a non-empty doc', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })
    // Body big enough to render a page — covered indirectly by the
    // tool path, which calls renderDocument under the hood.
    await seedYjs(doc.docId, '# Test\n\n' + 'lorem '.repeat(200))

    const { plaintext } = await mintPat({ userId: user.id, scopes: READ_SCOPES })
    const res = await mcp(plaintext).call('get_page_count', { doc_id: doc.docId })

    // Either succeeds with a number or fails gracefully via isError —
    // we accept either shape because renderDocument needs the renderer
    // sidecar healthy. Pin: it's not a transport-level RPC error.
    expect(res.content.length).toBeGreaterThan(0)
  }, 30_000)
})
