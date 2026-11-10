import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { handleExportDocumentAsMarkdown } from '../../server/utils/aiToolAdapter'
import type { DocToolContext } from '../../server/utils/agentic/toolContext'
import { FULL_AI_PROVIDERS } from './fixtures/aiProviders'
import { getDoc, type DocSnapshot } from '../../server/repos/documents'
import { splitMarkotoFrontmatter } from '../../shared/utils/markdownFrontmatter'
import { THEME_PRESETS } from '../../shared/utils/themePresets'
import { defaultTheme } from '../../shared/utils/defaultTheme'

// export_document_as_markdown (in-editor AI + MCP) writes the same file
// as the editor's "Download Markdown": markoto frontmatter (theme + doc
// properties, built by shared/utils/markdownFrontmatter.ts) + the raw
// body. The file must read back through the import's own parser.

vi.mock('../../server/repos/documents', async (importOriginal) => {
  const actual = await importOriginal<object>()
  return {
    ...actual,
    getDoc: vi.fn(),
    // Share-link controls (WP9): the caller may download (no view-only link).
    getDocWithActorRole: vi.fn(async () => ({ ownerId: null, workspaceId: null, accessMode: 'open-edit', ownerAccessSuspended: false, workspaceRole: null, isGuest: false, shareExpiresAt: null, shareNoDownload: false }))
  }
})
const mockedGetDoc = vi.mocked(getDoc)

const arxiv = THEME_PRESETS.find(p => p.id === 'arxiv')?.theme
if (!arxiv) throw new Error('arxiv preset missing')

function row(overrides: Partial<DocSnapshot> = {}): DocSnapshot {
  return {
    docId: 'doc1',
    ownerId: null,
    workspaceId: null,
    accessMode: 'open-edit',
    title: 'Row title',
    passwordHash: null,
    theme: null,
    wordCount: null,
    sizeBytes: null,
    description: 'About the report',
    audience: 'business',
    language: 'fr',
    templateId: 'blank',
    createdAt: new Date(),
    lastActive: new Date(),
    ...overrides
  }
}

function session(body: string, meta: Record<string, unknown> = {}): DocToolContext {
  const ydoc = new Y.Doc()
  ydoc.getText('content').insert(0, body)
  const ymeta = ydoc.getMap<unknown>('meta')
  for (const [k, v] of Object.entries(meta)) ymeta.set(k, v)
  return {
    docId: 'doc1',
    initiatorUserId: 1,
    workspaceId: null,
    sessionId: 's1',
    attributedTo: 'user:1',
    plan: 'free',
    periodStart: new Date(),
    virtualKey: 'sk-test',
    aiProviders: FULL_AI_PROVIDERS,
    updateStatus: vi.fn(),
    ydoc,
    ytext: ydoc.getText('content'),
    ymeta,
    awareness: new Awareness(ydoc)
  }
}

const run = (ctx: DocToolContext) => handleExportDocumentAsMarkdown(ctx, { doc_id: 'doc1' })

beforeEach(() => {
  mockedGetDoc.mockReset()
})

describe('export_document_as_markdown', () => {
  it('writes markoto frontmatter (live ymeta theme + properties) above the raw body', async () => {
    mockedGetDoc.mockResolvedValue(row())
    const body = '# Report\n\nLine one.\n'
    const res = await run(session(body, { theme: arxiv, title: 'Live title' }))
    expect(res.isError).toBe(false)
    const split = splitMarkotoFrontmatter(String(res.content))
    expect(split.kind).toBe('markoto')
    if (split.kind !== 'markoto') return
    expect(split.body).toBe(body)
    expect(split.data).toMatchObject({
      markoto: 1,
      title: 'Live title',
      description: 'About the report',
      audience: 'business',
      language: 'fr',
      templateId: 'blank',
      theme: arxiv
    })
    // No line-number prefixes (that's view_document).
    expect(String(res.content)).not.toMatch(/^1:\s/m)
  })

  it('no theme anywhere → the default theme, like the editor download', async () => {
    mockedGetDoc.mockResolvedValue(row())
    const res = await run(session('x'))
    const split = splitMarkotoFrontmatter(String(res.content))
    expect(split.kind === 'markoto' && split.data.theme).toEqual(defaultTheme)
  })

  it('errors when the document row is gone', async () => {
    mockedGetDoc.mockResolvedValue(null)
    const res = await run(session('x'))
    expect(res.isError).toBe(true)
  })
})
