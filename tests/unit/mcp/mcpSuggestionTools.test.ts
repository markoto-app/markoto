import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { z } from 'zod'
import { anchorRange, suggestionsMap } from '../../../shared/utils/suggestions/ySuggestions'

// The MCP suggestion tools and the session they run in: who may suggest,
// who may accept or reject, and how a document that requires suggestions
// turns a caller's text edits into suggestions of their MCP session.

const h = vi.hoisted(() => ({
  proven: null as null | Record<string, unknown>,
  mayDownload: true,
  suggestMode: null as null | { forced: boolean },
  connectArgs: null as null | Record<string, unknown>,
  release: vi.fn(),
  exec: vi.fn(),
  resolve: vi.fn(),
  ctx: null as unknown as Record<string, unknown>,
  sessionHeader: undefined as string | undefined
}))

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (def: unknown) => def }))
vi.mock('../../../server/utils/access/shareSettings', () => ({ DOWNLOAD_DISABLED_MESSAGE: 'no downloads', userMayDownload: vi.fn(async () => h.mayDownload) }))
vi.mock('../../../server/utils/access/workspaceAccess', () => ({ proveWorkspaceAccess: vi.fn(async () => ({ ws: true })) }))
vi.mock('../../../server/utils/access/docProof', () => ({ proveDocMembership: vi.fn(async () => h.proven) }))
vi.mock('../../../server/utils/access/userProof', () => ({ proveSelf: (userId: number) => ({ userId }) }))
vi.mock('../../../server/repos/users', () => ({ findUserName: vi.fn(async () => 'Dana') }))
vi.mock('../../../server/utils/mcp/mcpHocuspocusClient', () => ({
  connectAsMcpClient: vi.fn(async (args: Record<string, unknown>) => {
    h.connectArgs = args
    return { ctx: h.ctx, release: h.release }
  })
}))
vi.mock('../../../server/utils/ai/tools/registry', () => ({ executeFunctionByName: (...a: unknown[]) => h.exec(...a), executeMetaTool: vi.fn() }))
vi.mock('../../../server/mcp/lib/mcpToolContext', () => ({
  requireMcpAuth: () => ({ userId: 5 }), hasScope: () => true, toolEnabled: () => true
}))
vi.mock('../../../server/utils/billing/billing', () => ({ resolveBillingContext: vi.fn() }))
vi.mock('../../../server/utils/aiProviders/resolve', () => ({ resolveAiProviders: vi.fn() }))
vi.mock('../../../server/utils/platform/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true) }))
vi.mock('../../../server/utils/rendering/renderRateLimit', () => ({ consumeRenderAllowance: vi.fn(async () => true) }))
vi.mock('../../../server/utils/billing/billingMode', () => ({ limitRecovery: () => 'none' }))
vi.mock('../../../server/utils/api/apiError', () => ({ apiError: (code: string) => Object.assign(new Error(code), { code }) }))
vi.mock('../../../server/utils/agentic/sessions/suggestMode', () => ({ sessionSuggestMode: vi.fn(async () => h.suggestMode) }))
vi.mock('../../../server/utils/suggestions/resolveSuggestions', () => ({ resolveSuggestions: (...a: unknown[]) => h.resolve(...a) }))
vi.mock('../../../server/utils/agentic/toolContext', () => ({ writeAccessOf: (ctx: { docAccess: unknown }) => ctx.docAccess }))
vi.stubGlobal('useEvent', () => ({ context: {} }))
vi.stubGlobal('getHeader', () => h.sessionHeader)

const unsafe = (v: unknown): never => v as never
const noExtra = Object.create(null) as never

const wrap = await import('../../../server/mcp/lib/wrapDocBoundTool')
const tools = await import('../../../server/mcp/lib/suggestionTools')
const accept = (await import('../../../server/mcp/tools/accept_suggestions')).default as unknown as ToolDef
const reject = (await import('../../../server/mcp/tools/reject_suggestions')).default as unknown as ToolDef
const list = (await import('../../../server/mcp/tools/list_suggestions')).default as unknown as ToolDef
const suggest = (await import('../../../server/mcp/tools/suggest_edit')).default as unknown as ToolDef

interface ToolDef { name: string, handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }>, isError?: boolean }> }

function freshCtx(text = 'The quick brown fox') {
  const ydoc = new Y.Doc()
  ydoc.getText('content').insert(0, text)
  h.ctx = { ydoc, ytext: ydoc.getText('content'), initiatorUserId: 5, docAccess: { docId: 'd1', allows: () => true }, suggestSink: undefined }
  return ydoc
}

beforeEach(() => {
  h.proven = { workspaceId: 'ws1', access: { docId: 'd1' }, row: { r: 1 } }
  h.mayDownload = true
  h.suggestMode = null
  h.sessionHeader = 'sess-1'
  h.release.mockReset()
  h.exec.mockReset()
  h.resolve.mockReset()
  freshCtx()
})

const call = (t: ToolDef, args: Record<string, unknown> = {}) => t.handler({ doc_id: 'd1', ...args }, {})

describe('suggestion tool session', () => {
  it('answers 404-shaped for a missing or refused document, before connecting', async () => {
    h.proven = null
    await expect(call(list)).rejects.toThrow('mcp/doc-not-found')
    expect(h.connectArgs).toBeNull()
  })

  it('requires a doc_id', async () => {
    await expect(list.handler({ doc_id: '' }, {})).rejects.toThrow('mcp/missing-doc-id')
  })

  it('refuses a download-restricted document for tools that carry it out, and runs others', async () => {
    h.mayDownload = false
    const doc = { doc_id: z.string() }
    const carrying = wrap.buildDocBoundTool({ name: 'view_pages' as never, description: 'd', inputSchema: doc, scope: 'documents:read', access: 'view', download: true })
    const refused = await carrying.handler({ doc_id: 'd1' }, noExtra)
    expect(refused).toEqual({ content: [{ type: 'text', text: 'no downloads' }], isError: true })
    expect(h.connectArgs).toBeNull()
    h.exec.mockResolvedValue({ content: 'done', isError: false })
    const plain = wrap.buildDocBoundTool({ name: 'view_document' as never, description: 'd', inputSchema: { ...doc, extra: z.number().optional() }, scope: 'documents:read', access: 'view' })
    const ok = await plain.handler({ doc_id: 'd1', extra: 1 }, noExtra)
    expect(JSON.stringify(ok)).toContain('"text":"done"')
    // the wrapper's doc_id never reaches the tool
    expect(h.exec).toHaveBeenCalledWith(h.ctx, 'view_document', { extra: 1 })
    expect(h.release).toHaveBeenCalled()
  })

  it('connects with the MCP session id and releases the handle even when the tool throws', async () => {
    const t = wrap.buildDocSessionTool({ name: 'boom_tool', description: 'd', inputSchema: { doc_id: z.string() }, scope: 'documents:read', access: 'view', run: async () => {
      throw new Error('inside')
    } })
    await expect(t.handler({ doc_id: 'd1' }, noExtra)).rejects.toThrow('inside')
    expect(h.release).toHaveBeenCalledTimes(1)
    expect(h.connectArgs).toMatchObject({ docId: 'd1', userId: 5, mcpSessionId: 'sess-1', userName: 'Dana', workspaceId: 'ws1' })
  })

  it('falls back to a one-shot session id without the header and skips workspace proof without a workspace', async () => {
    h.sessionHeader = undefined
    h.proven = { workspaceId: null, access: { docId: 'd1' }, row: {} }
    await call(list)
    expect(String(h.connectArgs!.mcpSessionId)).toMatch(/^oneshot-/)
    expect(h.connectArgs!.workspaceAccess).toBeNull()
  })

  it('rejects an input schema without doc_id', () => {
    expect(() => wrap.buildDocSessionTool({ name: 'no_doc', description: 'd', inputSchema: {}, scope: 'documents:read', access: 'view', run: async () => ({ content: [] }) })).toThrow(/doc_id/)
  })

  it('puts a session into suggesting mode as its MCP principal when the document requires it', async () => {
    h.suggestMode = { forced: true }
    await call(accept)
    expect(h.ctx.suggestSink).toEqual({ principal: 'mcp:sess-1', name: 'MCP', forced: true, written: 0 })
  })

  it('sets no sink for an edit session when no suggestion mode applies', async () => {
    h.suggestMode = null
    h.resolve.mockResolvedValue({ resolved: 0, missing: 0 })
    await call(accept)
    expect(h.ctx.suggestSink).toBeNull()
  })

  it('does not look up suggestion mode for view access', async () => {
    h.suggestMode = { forced: true }
    h.ctx.suggestSink = undefined
    await call(list)
    expect(h.ctx.suggestSink).toBeNull()
  })
})

describe('list_suggestions', () => {
  it('lists suggestions with kind, author key, live struck text and ISO time', async () => {
    const ydoc = h.ctx.ydoc as Y.Doc
    const ytext = ydoc.getText('content')
    const base = { v: 1, authorAvatarSeed: null, color: '#112233', groupId: null, jobId: null, updatedAt: 1 }
    suggestionsMap(ydoc).set('s-human01', { ...base, id: 's-human01', ...anchorRange(ytext, 4, 9), text: 'slow', deleted: 'quick', authorId: 3, authorName: 'Bea', authorPrincipal: null, createdAt: 0 })
    suggestionsMap(ydoc).set('s-ai00001', { ...base, id: 's-ai00001', ...anchorRange(ytext, 16, 19), text: '', deleted: 'fox', authorId: null, authorName: 'markoto', authorPrincipal: 'mcp:x', createdAt: 0 })
    ytext.delete(16, 3)
    const out = JSON.parse((await call(list)).content[0]!.text)
    expect(out.suggestions).toHaveLength(2)
    const human = out.suggestions.find((s: { id: string }) => s.id === 's-human01')
    expect(human).toMatchObject({ kind: 'replace', author: 'Bea', author_key: 'user:3', struck_text: 'quick', inserted_text: 'slow', changed_since: false, created_at: '1970-01-01T00:00:00.000Z' })
    const ai = out.suggestions.find((s: { id: string }) => s.id === 's-ai00001')
    expect(ai).toMatchObject({ kind: 'obsolete', author: 'AI', author_key: 'ai' })
  })
})

describe('suggest_edit', () => {
  it('runs replace_text against a suggestion sink of the session and returns its message', async () => {
    h.exec.mockResolvedValue({ content: 'Suggestion mode: recorded', isError: false })
    const r = await call(suggest, { old_str: 'quick', new_str: 'slow' })
    expect(h.exec).toHaveBeenCalledWith(h.ctx, 'replace_text', { old_str: 'quick', new_str: 'slow' })
    expect(h.ctx.suggestSink).toEqual({ principal: 'mcp:sess-1', name: 'MCP', forced: false, written: 0 })
    expect(r).toEqual({ content: [{ type: 'text', text: 'Suggestion mode: recorded' }], isError: false })
  })

  it('passes an error through', async () => {
    h.exec.mockResolvedValue({ content: 'no match', isError: true })
    expect((await call(suggest, { old_str: 'zzz', new_str: '' })).isError).toBe(true)
  })
})

describe('accept_suggestions / reject_suggestions', () => {
  it('forwards ids or author key and reports the counts', async () => {
    h.resolve.mockResolvedValue({ resolved: 2, missing: 1 })
    const r = await call(accept, { suggestion_ids: ['a', 'b'] })
    expect(h.resolve).toHaveBeenCalledWith({ doc: (h.ctx.docAccess), reviewer: { userId: 5, name: 'Dana' }, action: 'accept', select: { ids: ['a', 'b'] } })
    expect(r.content[0]!.text).toBe('Accepted 2 suggestions. 1 no longer existed.')

    h.resolve.mockResolvedValue({ resolved: 1, missing: 0 })
    expect((await call(reject, { author_key: 'ai' })).content[0]!.text).toBe('Rejected 1 suggestion.')
    expect(h.resolve.mock.lastCall![0].select).toEqual({ authorKey: 'ai' })

    await call(accept)
    expect(h.resolve.mock.lastCall![0].select).toEqual({})
  })

  it('refuses people who must suggest, without touching the document', async () => {
    h.suggestMode = { forced: true }
    for (const t of [accept, reject]) {
      const r = await call(t)
      expect(r.isError).toBe(true)
      expect(r.content[0]!.text).toContain('only people who edit it directly')
    }
    expect(h.resolve).not.toHaveBeenCalled()
  })

  it('exposes decideSuggestions directly', async () => {
    h.resolve.mockResolvedValue({ resolved: 0, missing: 0 })
    const r = await tools.decideSuggestions(unsafe({ handle: { ctx: h.ctx }, mustSuggest: false, userName: 'Dana' }), 'reject', {})
    expect(r.content).toEqual([{ type: 'text', text: 'Rejected 0 suggestions.' }])
  })
})
