import { describe, it, expect, vi } from 'vitest'
import {
  CrossBoundaryGuard,
  CONFIRM_WHEN_TAINTED,
  extractTypedUrls,
  normalizeUrlForCompare,
  type CrossBoundaryDeps,
  type CrossBoundaryInit
} from '../../server/utils/agentic/crossBoundary'

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
  it('never asks — every tool runs as before', async () => {
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
    ['list_workspace_documents', {}]
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
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.message).toMatch(/did not allow.*Do not retry/s)
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

  it('fetch_url runs without asking only for a URL the invoker typed — exactly', async () => {
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
