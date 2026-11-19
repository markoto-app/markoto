// Unit tests for the cross-document AI tool handlers
// (`list_workspace_documents`, `list_my_documents` and `view_other_document`).
//
// Tests describe the SPECIFIED CONTRACT, not the current implementation.
// If the handler is ever refactored, the assertions should still hold
// without rewrites. Where current code happens to produce a particular
// string, the assertions look for the load-bearing fragment, not the
// full output, so cosmetic tweaks don't break tests.
//
// Mocks: the data-access dependencies (`getDocWithActorRole`,
// `listScopeDocs`, `listFolders`, `openTrustedCommentClient`).
// Pure-function imports (`decideTokenAccess`) are called for real.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'

import { executeFunctionByName } from '../../../server/utils/ai/tools/registry'
import { TOOL_RESULT_CHAR_CAP } from '../../../server/utils/agentic/limits'
import { listScopeDocs } from '../../../server/repos/documents'
import { listFolders } from '../../../server/repos/folders'
import { getDocWithActorRole } from '../../../server/repos/access/docAuthz'
import { openTrustedCommentClient } from '../../../server/utils/documents/commentsServerClient'
import type { AiSession } from '../../../server/utils/ai/aiClient'
import { partial } from '../../helpers/fixtures'
import { asUser, docAs, wsRole } from '../../helpers/access'

// Module-level mocks must come BEFORE importing the SUT.
vi.mock('../../../server/repos/documents', async (importOriginal) => {
  const actual = await importOriginal<object>()
  return {
    ...actual,
    // Stubs are reset per test via `beforeEach`. The test file installs
    // a behaviour for each function via `vi.mocked(fn).mockResolvedValue(...)`.
    listScopeDocs: vi.fn(),
    // The handler also calls `getDoc` for the current-theme fallback in
    // theme tools: leave it un-stubbed so unrelated branches don't trip.
    getDoc: actual && (actual as { getDoc?: unknown }).getDoc
      ? (actual as { getDoc: unknown }).getDoc
      : vi.fn()
  }
})

vi.mock('../../../server/repos/access/docAuthz', async importOriginal => ({
  ...await importOriginal<object>(),
  getDocWithActorRole: vi.fn()
}))

vi.mock('../../../server/repos/folders', async importOriginal => ({
  ...await importOriginal<object>(),
  listFolders: vi.fn()
}))

vi.mock('../../../server/utils/documents/commentsServerClient', () => ({
  openTrustedCommentClient: vi.fn()
}))

// `updateDocMeta` is also imported by aiToolAdapter for theme writes;
// don't let an accidental call here hit the real DB code path.
vi.mock('../../../server/repos/documents', async (importOriginal) => {
  const actual = await importOriginal<object>()
  return {
    ...actual,
    listScopeDocs: vi.fn(),
    updateDocMeta: vi.fn().mockResolvedValue(undefined)
  }
})

const mockedGetCtx = vi.mocked(getDocWithActorRole)
const mockedListDocs = vi.mocked(listScopeDocs)
const mockedListFolders = vi.mocked(listFolders)
const mockedOpenTrusted = vi.mocked(openTrustedCommentClient)

// Session stub. Handler reads:
//   - session.docId           (current doc id)
//   - session.workspaceId     (workspace gating)
//   - session.initiatorUserId (access decisions)
//   - session.sessionId       (audit principal in trusted-client open)
//   - session.ymeta / .ydoc   (theme tools, irrelevant here)
//   - session.updateStatus()  (cosmetic, must not throw)
function makeSession(opts: {
  docId?: string
  workspaceId?: string | null
  initiatorUserId?: number
  sessionId?: string
} = {}): AiSession {
  const ydoc = new Y.Doc()
  const userId = opts.initiatorUserId ?? 100
  const docId = opts.docId ?? 'CURRENT_DOC'
  return {
    docId,
    workspaceId: opts.workspaceId ?? null,
    initiatorUserId: userId,
    // The proofs the session was opened with: the initiator, their write
    // access to the current document and their membership of its workspace.
    self: asUser(userId),
    docAccess: docAs(docId, userId),
    workspaceAccess: opts.workspaceId ? wsRole(opts.workspaceId, userId, 'editor') : null,
    sessionId: opts.sessionId ?? 'sess-1',
    ydoc,
    ytext: ydoc.getText('content'),
    ymeta: ydoc.getMap('meta'),
    awareness: null as never,
    provider: null as never,
    updateStatus: vi.fn(),
    destroy: async () => {}
  } as unknown as AiSession
}

// Helper: build a getDocWithActorRole context for stubbing.
type ActorCtx = NonNullable<Awaited<ReturnType<typeof getDocWithActorRole>>>
function ctx(over: Partial<ActorCtx> = {}): ActorCtx {
  return partial<ActorCtx>({
    title: 'Target doc',
    description: '',
    audience: 'casual',
    language: 'en',
    templateId: 'blank',
    ownerId: 999,
    workspaceId: null,
    workspaceRole: null,
    accessMode: 'private',
    theme: null,
    ...over
  })
}

// Helper: build the trusted-client return value with given body text.
// destroy is a spy so tests can assert it was called.
function makeTrustedClient(body: string) {
  const ydoc = new Y.Doc()
  ydoc.getText('content').insert(0, body)
  const destroy = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  return {
    ydoc,
    ycomments: ydoc.getArray<Y.Map<unknown>>('comments'),
    acknowledged: () => Promise.resolve(),
    destroy
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// view_other_document

describe('view_other_document: input parsing precedes access check', () => {
  it('parses a markoto URL down to a bare id BEFORE looking up the doc', async () => {
    // Spec: the handler MUST extract the id from a URL before calling
    // the access helper, so the user can paste a URL verbatim.
    mockedGetCtx.mockResolvedValue(ctx({ ownerId: 100 }))
    mockedOpenTrusted.mockResolvedValue(makeTrustedClient('hi'))
    const session = makeSession({ initiatorUserId: 100 })
    await executeFunctionByName(session, 'view_other_document', {
      doc_id: 'https://markoto.app/d/xyz?slide=2'
    })
    // The repo call must receive the parsed id, not the raw URL.
    expect(mockedGetCtx).toHaveBeenCalledWith('xyz', 100)
  })

  it('accepts a bare id and forwards it unchanged', async () => {
    mockedGetCtx.mockResolvedValue(ctx({ ownerId: 100 }))
    mockedOpenTrusted.mockResolvedValue(makeTrustedClient('hi'))
    const session = makeSession({ initiatorUserId: 100 })
    await executeFunctionByName(session, 'view_other_document', { doc_id: 'abc' })
    expect(mockedGetCtx).toHaveBeenCalledWith('abc', 100)
  })

  it('returns an error WITHOUT calling the access helper when the id is unparsable', async () => {
    // Spec: garbage input must NOT cause a DB query (the parser is the
    // first gate). A test that only checks the message would fail
    // silently if the order changed.
    const session = makeSession()
    const res = await executeFunctionByName(session, 'view_other_document', {
      doc_id: 'not a url and not an id either'
    })
    expect(res.isError).toBe(true)
    expect(mockedGetCtx).not.toHaveBeenCalled()
    expect(mockedOpenTrusted).not.toHaveBeenCalled()
  })
})

describe('view_other_document: current-doc rejection precedes access check', () => {
  it('refuses to read the current document and points at view_document', async () => {
    // Spec: calling view_other_document on the SAME id the session
    // already has open must be rejected without a DB query, the
    // model should be steered to view_document for the local doc.
    const session = makeSession({ docId: 'SELF' })
    const res = await executeFunctionByName(session, 'view_other_document', { doc_id: 'SELF' })
    expect(res.isError).toBe(true)
    expect(res.content.toLowerCase()).toContain('view_document')
    expect(mockedGetCtx).not.toHaveBeenCalled()
    expect(mockedOpenTrusted).not.toHaveBeenCalled()
  })

  it('rejects when the URL form resolves to the current doc', async () => {
    // Same rule, but the user pasted a URL pointing at the current
    // doc. Must short-circuit BEFORE access check.
    const session = makeSession({ docId: 'SELF' })
    const res = await executeFunctionByName(session, 'view_other_document', {
      doc_id: 'https://markoto.app/d/SELF/'
    })
    expect(res.isError).toBe(true)
    expect(mockedGetCtx).not.toHaveBeenCalled()
  })
})

describe('view_other_document: access decisions', () => {
  it('returns 404-shape when the doc does not exist', async () => {
    // Spec: non-existent ids return the SAME shape as "exists but
    // forbidden" so an attacker can't enumerate ids by error message.
    mockedGetCtx.mockResolvedValue(null)
    const session = makeSession()
    const res = await executeFunctionByName(session, 'view_other_document', { doc_id: 'ghost' })
    expect(res.isError).toBe(true)
    expect(res.content.toLowerCase()).toContain('not found')
    // CRITICAL: must NOT have opened a trusted client for a doc the
    // initiator can't see. Even probing the sync server would be a
    // sidechannel.
    expect(mockedOpenTrusted).not.toHaveBeenCalled()
  })

  it('returns 404-shape (NOT a forbidden message) on private-doc-by-stranger', async () => {
    // Spec: anti-enumeration. "exists but no access" must be
    // indistinguishable from "doesn't exist".
    mockedGetCtx.mockResolvedValue(ctx({
      ownerId: 999,
      accessMode: 'private',
      workspaceId: null,
      workspaceRole: null
    }))
    const session = makeSession({ initiatorUserId: 100 })
    const res = await executeFunctionByName(session, 'view_other_document', { doc_id: 'priv' })
    expect(res.isError).toBe(true)
    expect(res.content.toLowerCase()).toContain('not found')
    // Must not leak "forbidden" wording, that distinguishes the case.
    expect(res.content.toLowerCase()).not.toContain('forbidden')
    expect(mockedOpenTrusted).not.toHaveBeenCalled()
  })

  it('returns DISTINCT password message for non-member of password-protected doc', async () => {
    // Spec: when the user IS recognised but the doc requires a
    // password they don't have, the message must explain, not
    // 404-mask: because the user's next step is to ask for a share.
    mockedGetCtx.mockResolvedValue(ctx({
      ownerId: 999,
      accessMode: 'password-protected',
      workspaceId: null,
      workspaceRole: null
    }))
    const session = makeSession({ initiatorUserId: 100 })
    const res = await executeFunctionByName(session, 'view_other_document', { doc_id: 'pw' })
    expect(res.isError).toBe(true)
    expect(res.content.toLowerCase()).toContain('password')
    expect(mockedOpenTrusted).not.toHaveBeenCalled()
  })

  it('allows owner read on their own private doc', async () => {
    mockedGetCtx.mockResolvedValue(ctx({
      ownerId: 100,
      accessMode: 'private'
    }))
    mockedOpenTrusted.mockResolvedValue(makeTrustedClient('owned content'))
    const session = makeSession({ initiatorUserId: 100 })
    const res = await executeFunctionByName(session, 'view_other_document', { doc_id: 't' })
    expect(res.isError).toBe(false)
    expect(res.content).toContain('owned content')
  })

  it('allows workspace VIEWER on a private workspace doc (read-only is enough)', async () => {
    // Spec: viewer access is sufficient for the AI tool. Confirmed
    // with the user: symmetric with what a viewer can see in the
    // browser.
    mockedGetCtx.mockResolvedValue(ctx({
      ownerId: 999,
      accessMode: 'private',
      workspaceId: 'WS-A',
      workspaceRole: 'viewer'
    }))
    mockedOpenTrusted.mockResolvedValue(makeTrustedClient('viewer can read'))
    const session = makeSession({ initiatorUserId: 100, workspaceId: 'WS-A' })
    const res = await executeFunctionByName(session, 'view_other_document', { doc_id: 't' })
    expect(res.isError).toBe(false)
    expect(res.content).toContain('viewer can read')
  })

  it('workspace MEMBERSHIP bypasses the password gate', async () => {
    // Spec: if the doc is in a workspace the user belongs to,
    // membership lifts the password requirement (same as the editor
    // URL behaviour). Drift here would either over-tighten or
    // over-loosen access.
    mockedGetCtx.mockResolvedValue(ctx({
      ownerId: 999,
      accessMode: 'password-protected',
      workspaceId: 'WS-A',
      workspaceRole: 'editor'
    }))
    mockedOpenTrusted.mockResolvedValue(makeTrustedClient('member bypass works'))
    const session = makeSession({ initiatorUserId: 100, workspaceId: 'WS-A' })
    const res = await executeFunctionByName(session, 'view_other_document', { doc_id: 't' })
    expect(res.isError).toBe(false)
    expect(res.content).toContain('member bypass works')
  })

  it('non-member of doc-owning workspace gets 404 on private doc (cross-workspace isolation)', async () => {
    // Spec: workspace A membership does NOT grant access to
    // workspace B docs. The repo helper handles this by returning
    // workspaceRole=null when the actor isn't a member of THAT
    // workspace.
    mockedGetCtx.mockResolvedValue(ctx({
      ownerId: 999,
      accessMode: 'private',
      workspaceId: 'WS-B',
      workspaceRole: null
    }))
    const session = makeSession({ initiatorUserId: 100, workspaceId: 'WS-A' })
    const res = await executeFunctionByName(session, 'view_other_document', { doc_id: 't' })
    expect(res.isError).toBe(true)
    expect(res.content.toLowerCase()).toContain('not found')
  })

  it('allows anonymous/public read on open-edit', async () => {
    mockedGetCtx.mockResolvedValue(ctx({
      ownerId: 999,
      accessMode: 'open-edit',
      workspaceId: null,
      workspaceRole: null
    }))
    mockedOpenTrusted.mockResolvedValue(makeTrustedClient('public-edit body'))
    const session = makeSession({ initiatorUserId: 100 })
    const res = await executeFunctionByName(session, 'view_other_document', { doc_id: 't' })
    expect(res.isError).toBe(false)
    expect(res.content).toContain('public-edit body')
  })

  it('allows anonymous/public read on open-view', async () => {
    mockedGetCtx.mockResolvedValue(ctx({
      ownerId: 999,
      accessMode: 'open-view',
      workspaceId: null,
      workspaceRole: null
    }))
    mockedOpenTrusted.mockResolvedValue(makeTrustedClient('public-view body'))
    const session = makeSession({ initiatorUserId: 100 })
    const res = await executeFunctionByName(session, 'view_other_document', { doc_id: 't' })
    expect(res.isError).toBe(false)
    expect(res.content).toContain('public-view body')
  })
})

describe('view_other_document: body formatting', () => {
  it('numbers lines starting at 1 (matches view_document)', async () => {
    // Spec: line numbers are 1-indexed and prefixed `N: <line>` so
    // the model can quote/replace specific lines. Same shape as the
    // local view_document tool.
    mockedGetCtx.mockResolvedValue(ctx({ ownerId: 100 }))
    mockedOpenTrusted.mockResolvedValue(makeTrustedClient('alpha\nbeta\ngamma'))
    const session = makeSession({ initiatorUserId: 100 })
    const res = await executeFunctionByName(session, 'view_other_document', { doc_id: 't' })
    expect(res.isError).toBe(false)
    expect(res.content).toMatch(/(^|\n)1:\s*alpha/)
    expect(res.content).toMatch(/(^|\n)2:\s*beta/)
    expect(res.content).toMatch(/(^|\n)3:\s*gamma/)
  })

  it('returns the outline and first lines of a long document, with a view_range hint naming the doc', async () => {
    // Spec: long docs stay within the tool result budget; the result says
    // how to read the rest.
    const lines = ['# Part one']
    for (let i = 0; i < 300; i++) lines.push('x'.repeat(120))
    lines.push('# Part two')
    for (let i = 0; i < 300; i++) lines.push('y'.repeat(120))
    mockedGetCtx.mockResolvedValue(ctx({ ownerId: 100 }))
    mockedOpenTrusted.mockResolvedValue(makeTrustedClient(lines.join('\n')))
    const session = makeSession({ initiatorUserId: 100 })
    const res = await executeFunctionByName(session, 'view_other_document', { doc_id: 't' })
    expect(res.isError).toBe(false)
    expect(res.content.length).toBeLessThanOrEqual(TOOL_RESULT_CHAR_CAP)
    expect(res.content).toContain('too long for one result')
    expect(res.content).toContain('[1-301] # Part one')
    expect(res.content).toContain('[302-602] # Part two')
    expect(res.content).toContain('view_other_document (doc_id "t") and view_range')
  })

  it('a ranged read that does not fit says which range continues it', async () => {
    const lines = Array.from({ length: 600 }, () => 'z'.repeat(120))
    mockedGetCtx.mockResolvedValue(ctx({ ownerId: 100 }))
    mockedOpenTrusted.mockResolvedValue(makeTrustedClient(lines.join('\n')))
    const session = makeSession({ initiatorUserId: 100 })
    const res = await executeFunctionByName(session, 'view_other_document', { doc_id: 't', view_range: [1, -1] })
    expect(res.content).toMatch(/Continue with view_other_document \(doc_id "t"\) and view_range \[\d+, \d+\]/)
  })

  it('a short document comes back in full, without hints', async () => {
    mockedGetCtx.mockResolvedValue(ctx({ ownerId: 100 }))
    mockedOpenTrusted.mockResolvedValue(makeTrustedClient('short'))
    const session = makeSession({ initiatorUserId: 100 })
    const res = await executeFunctionByName(session, 'view_other_document', { doc_id: 't' })
    expect(res.isError).toBe(false)
    const bodySection = res.content.split('--- metadata ---')[0]!
    expect(bodySection.startsWith('1: short')).toBe(true)
    expect(bodySection).not.toContain('view_range')
    const meta = JSON.parse((res.content.split('--- metadata ---')[1] ?? '').trim())
    expect(meta.line_count).toBe(1)
  })

  it('tells the model to cite the document by title, never by its bare id', async () => {
    mockedGetCtx.mockResolvedValue(ctx({ ownerId: 100 }))
    mockedOpenTrusted.mockResolvedValue(makeTrustedClient('short'))
    const session = makeSession({ initiatorUserId: 100 })
    const res = await executeFunctionByName(session, 'view_other_document', { doc_id: 't' })
    expect(res.isError).toBe(false)
    const beforeMeta = res.content.split('--- metadata ---')[0] ?? ''
    expect(beforeMeta).toMatch(/call it by its title/)
    expect(beforeMeta).toMatch(/\[[^\]]+\]\(\/d\/t\)/)
    expect(beforeMeta).toMatch(/Never write the bare document id/)
  })

  it('view_range slices to the requested line range with 1-indexed inclusive bounds', async () => {
    mockedGetCtx.mockResolvedValue(ctx({ ownerId: 100 }))
    mockedOpenTrusted.mockResolvedValue(
      makeTrustedClient('a\nb\nc\nd\ne\nf')
    )
    const session = makeSession({ initiatorUserId: 100 })
    const res = await executeFunctionByName(session, 'view_other_document', {
      doc_id: 't',
      view_range: [2, 4]
    })
    expect(res.isError).toBe(false)
    expect(res.content).toMatch(/(^|\n)2:\s*b/)
    expect(res.content).toMatch(/(^|\n)3:\s*c/)
    expect(res.content).toMatch(/(^|\n)4:\s*d/)
    // Lines outside the range must NOT appear in the body section.
    // Use ': a' / ': e' so we don't false-match the metadata block.
    const beforeMeta = res.content.split('--- metadata ---')[0]!
    expect(beforeMeta).not.toMatch(/(^|\n)1:\s*a/)
    expect(beforeMeta).not.toMatch(/(^|\n)5:\s*e/)
    expect(beforeMeta).not.toMatch(/(^|\n)6:\s*f/)
  })

  it('view_range with end=-1 reads from start through EOF', async () => {
    mockedGetCtx.mockResolvedValue(ctx({ ownerId: 100 }))
    mockedOpenTrusted.mockResolvedValue(
      makeTrustedClient('a\nb\nc\nd\ne')
    )
    const session = makeSession({ initiatorUserId: 100 })
    const res = await executeFunctionByName(session, 'view_other_document', {
      doc_id: 't',
      view_range: [3, -1]
    })
    expect(res.isError).toBe(false)
    expect(res.content).toMatch(/(^|\n)3:\s*c/)
    expect(res.content).toMatch(/(^|\n)4:\s*d/)
    expect(res.content).toMatch(/(^|\n)5:\s*e/)
    const beforeMeta = res.content.split('--- metadata ---')[0]!
    expect(beforeMeta).not.toMatch(/(^|\n)1:\s*a/)
    expect(beforeMeta).not.toMatch(/(^|\n)2:\s*b/)
  })
})

describe('view_other_document: metadata + scope label', () => {
  it('includes a parseable JSON metadata block with title, language, audience, scope', async () => {
    // Spec: the trailing metadata block is JSON so the model can
    // pull stable fields (title, scope) without parsing prose.
    mockedGetCtx.mockResolvedValue(ctx({
      ownerId: 100,
      title: 'My Notes',
      language: 'de',
      audience: 'academic'
    }))
    mockedOpenTrusted.mockResolvedValue(makeTrustedClient('hi'))
    const session = makeSession({ initiatorUserId: 100 })
    const res = await executeFunctionByName(session, 'view_other_document', { doc_id: 't' })
    expect(res.isError).toBe(false)
    const metaPart = res.content.split('--- metadata ---')[1] ?? ''
    const json = JSON.parse(metaPart.trim())
    expect(json.title).toBe('My Notes')
    expect(json.language).toBe('de')
    expect(json.audience).toBe('academic')
    expect(typeof json.scope).toBe('string')
  })

  it('scope = "self" when the initiator is the doc owner', async () => {
    mockedGetCtx.mockResolvedValue(ctx({ ownerId: 100, workspaceId: null, workspaceRole: null }))
    mockedOpenTrusted.mockResolvedValue(makeTrustedClient('hi'))
    const session = makeSession({ initiatorUserId: 100 })
    const res = await executeFunctionByName(session, 'view_other_document', { doc_id: 't' })
    const json = JSON.parse((res.content.split('--- metadata ---')[1] ?? '').trim())
    expect(json.scope).toBe('self')
  })

  it('scope reflects the workspace role when the initiator is a non-owner member', async () => {
    mockedGetCtx.mockResolvedValue(ctx({
      ownerId: 999, workspaceId: 'WS', workspaceRole: 'editor'
    }))
    mockedOpenTrusted.mockResolvedValue(makeTrustedClient('hi'))
    const session = makeSession({ initiatorUserId: 100, workspaceId: 'WS' })
    const res = await executeFunctionByName(session, 'view_other_document', { doc_id: 't' })
    const json = JSON.parse((res.content.split('--- metadata ---')[1] ?? '').trim())
    // Spec: scope must communicate WHY the read was allowed; the
    // role label is the most useful signal for the model. Match
    // against a fragment so a future "workspace member" / "ws:editor"
    // shape change doesn't break the test contract.
    expect(json.scope).toMatch(/workspace|editor|member/i)
  })

  it('scope reflects public access mode when the read goes through open-edit/open-view', async () => {
    mockedGetCtx.mockResolvedValue(ctx({
      ownerId: 999, accessMode: 'open-view', workspaceId: null, workspaceRole: null
    }))
    mockedOpenTrusted.mockResolvedValue(makeTrustedClient('hi'))
    const session = makeSession({ initiatorUserId: 100 })
    const res = await executeFunctionByName(session, 'view_other_document', { doc_id: 't' })
    const json = JSON.parse((res.content.split('--- metadata ---')[1] ?? '').trim())
    expect(json.scope).toMatch(/public|view|open/i)
  })
})

describe('view_other_document: trusted-client lifecycle', () => {
  it('always destroys the client on the success path', async () => {
    mockedGetCtx.mockResolvedValue(ctx({ ownerId: 100 }))
    const tc = makeTrustedClient('hi')
    mockedOpenTrusted.mockResolvedValue(tc)
    const session = makeSession({ initiatorUserId: 100 })
    await executeFunctionByName(session, 'view_other_document', { doc_id: 't' })
    expect(tc.destroy).toHaveBeenCalledTimes(1)
  })

  it('destroys the client even if the open succeeds but reading throws', async () => {
    // Spec: socket leaks are unacceptable, if any step AFTER the
    // open fails, we still tear down. Testing this catches the case
    // where someone refactors the handler and forgets a finally.
    mockedGetCtx.mockResolvedValue(ctx({ ownerId: 100 }))
    const tc = makeTrustedClient('hi')
    // Simulate a corrupted ydoc by overriding ytext.toString.
    const ytext = tc.ydoc.getText('content')
    ytext.toString = () => {
      throw new Error('synthetic-read-failure')
    }
    mockedOpenTrusted.mockResolvedValue(tc)
    const session = makeSession({ initiatorUserId: 100 })
    const res = await executeFunctionByName(session, 'view_other_document', { doc_id: 't' })
    expect(res.isError).toBe(true)
    expect(tc.destroy).toHaveBeenCalledTimes(1)
  })

  it('returns an error (not a crash) when openTrustedCommentClient throws', async () => {
    mockedGetCtx.mockResolvedValue(ctx({ ownerId: 100 }))
    mockedOpenTrusted.mockRejectedValue(new Error('sync-server unreachable'))
    const session = makeSession({ initiatorUserId: 100 })
    const res = await executeFunctionByName(session, 'view_other_document', { doc_id: 't' })
    expect(res.isError).toBe(true)
    expect(res.content.toLowerCase()).toMatch(/sync|unreachable|read/i)
  })

  it('passes the initiator user id (not the AI principal) into the trusted-client audit name', async () => {
    // Spec: the audit principal must reference the human, not the
    // AI's synthetic id, so cross-doc reads in the activity log
    // attribute back to the user who triggered them. Owner === initiator
    // here so the access check passes; we only care about the principal.
    mockedGetCtx.mockResolvedValue(ctx({ ownerId: 4242 }))
    mockedOpenTrusted.mockResolvedValue(makeTrustedClient('hi'))
    const session = makeSession({ initiatorUserId: 4242, sessionId: 'SES' })
    await executeFunctionByName(session, 'view_other_document', { doc_id: 't' })
    expect(mockedOpenTrusted).toHaveBeenCalledTimes(1)
    const [, principal] = mockedOpenTrusted.mock.calls[0] ?? ['', '']
    // Must include the initiator's user id so audit logs link back
    // to the human. The sessionId is a useful correlation handle.
    expect(principal).toContain('4242')
    expect(principal).toContain('SES')
  })
})

// list_workspace_documents / list_my_documents

type ScopeRow = Awaited<ReturnType<typeof listScopeDocs>>['rows'][number]
function row(over: Partial<ScopeRow> & { docId: string }): ScopeRow {
  const at = over.updatedAt ?? new Date('2026-04-30T10:00:00Z')
  return {
    title: 'Doc',
    description: '',
    language: 'en',
    accessMode: 'private',
    wordCount: 0,
    sizeBytes: 0,
    folderId: null,
    ownerId: 100,
    ownerName: 'Alice',
    isOwner: true,
    createdAt: at,
    updatedAt: at,
    lastActive: at,
    sortKey: at.toISOString(),
    ...over
  }
}

function folder(folderId: string, name: string, parentId: string | null = null) {
  const at = new Date('2026-01-01T00:00:00Z')
  return { folderId, parentId, name, position: 'a', createdAt: at, updatedAt: at, docCount: 0 }
}

describe('list_workspace_documents: gating', () => {
  it('errors when the current document is not in a workspace', async () => {
    // Spec: the tool only makes sense for workspace docs. Standalone
    // docs must surface a clear error so the model understands.
    const session = makeSession({ workspaceId: null })
    const res = await executeFunctionByName(session, 'list_workspace_documents', {})
    expect(res.isError).toBe(true)
    expect(res.content.toLowerCase()).toContain('workspace')
    expect(mockedListDocs).not.toHaveBeenCalled()
  })

  it('lists the session workspace, one page with the limit pushed into SQL', async () => {
    mockedListDocs.mockResolvedValue({ rows: [], total: 0 })
    mockedListFolders.mockResolvedValue([])
    const session = makeSession({ workspaceId: 'WS-A', initiatorUserId: 100 })
    await executeFunctionByName(session, 'list_workspace_documents', { limit: 20 })
    expect(mockedListDocs).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'WS-A', actor: { kind: 'user', userId: 100 } }),
      // One row more than the page tells whether another page follows.
      expect.objectContaining({ folder: 'all', sort: 'updated', limit: 21 })
    )
  })

  it('defaults to 50 rows per page', async () => {
    mockedListDocs.mockResolvedValue({ rows: [], total: 0 })
    mockedListFolders.mockResolvedValue([])
    await executeFunctionByName(makeSession({ workspaceId: 'WS-A' }), 'list_workspace_documents', {})
    expect(mockedListDocs).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ limit: 51 }))
  })
})

describe('list_workspace_documents: output shape', () => {
  it('returns compact rows with the folder path, total and a next_cursor while more pages follow', async () => {
    mockedListDocs.mockResolvedValue({
      rows: [
        row({ docId: 'A', title: 'Alpha', folderId: 'F2', description: 'x'.repeat(400) }),
        row({ docId: 'B', title: 'Beta' }),
        row({ docId: 'C', title: 'Gamma' })
      ],
      total: 7
    })
    mockedListFolders.mockResolvedValue([folder('F1', 'Projects'), folder('F2', '2026', 'F1')])
    const res = await executeFunctionByName(makeSession({ workspaceId: 'WS-A' }), 'list_workspace_documents', { limit: 2 })
    expect(res.isError).toBe(false)
    const out = JSON.parse(res.content)
    expect(out.total).toBe(7)
    expect(out.documents).toHaveLength(2)
    expect(out.documents[0]).toMatchObject({ doc_id: 'A', title: 'Alpha', folder: 'Projects / 2026', folder_id: 'F2', last_edited: '2026-04-30T10:00:00.000Z' })
    // Descriptions are cut: enough to recognise a document, not to read it.
    expect(out.documents[0].description.length).toBeLessThanOrEqual(160)
    expect(out.documents[1]).toMatchObject({ doc_id: 'B', folder: null })
    expect(typeof out.next_cursor).toBe('string')
    // Repo field names must not leak through.
    expect(res.content).not.toContain('"docId"')
  })

  it('marks the current document instead of dropping it (the page and total stay exact)', async () => {
    mockedListDocs.mockResolvedValue({ rows: [row({ docId: 'CURRENT' }), row({ docId: 'SIBLING' })], total: 2 })
    mockedListFolders.mockResolvedValue([])
    const res = await executeFunctionByName(makeSession({ docId: 'CURRENT', workspaceId: 'WS-A' }), 'list_workspace_documents', {})
    const out = JSON.parse(res.content)
    expect(out.documents.find((d: { doc_id: string }) => d.doc_id === 'CURRENT').current_document).toBe(true)
    expect(out.documents.find((d: { doc_id: string }) => d.doc_id === 'SIBLING').current_document).toBeUndefined()
    expect(out.next_cursor).toBe(null)
  })

  it('an invalid cursor is a tool error the model can correct, not a crash', async () => {
    const res = await executeFunctionByName(makeSession({ workspaceId: 'WS-A' }), 'list_workspace_documents', { cursor: 'not-a-cursor' })
    expect(res.isError).toBe(true)
    expect(mockedListDocs).not.toHaveBeenCalled()
  })
})

describe('list_my_documents', () => {
  it('lists the personal documents (owner scope, no workspace) even inside a workspace session', async () => {
    mockedListDocs.mockResolvedValue({ rows: [row({ docId: 'P1' })], total: 1 })
    mockedListFolders.mockResolvedValue([])
    const res = await executeFunctionByName(makeSession({ workspaceId: 'WS-A', initiatorUserId: 100 }), 'list_my_documents', { folder_id: 'root' })
    expect(res.isError).toBe(false)
    const scope = mockedListDocs.mock.calls[0]![0]
    expect('workspaceId' in scope).toBe(false)
    expect(mockedListDocs).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ folder: null }))
    expect(JSON.parse(res.content)).toMatchObject({ scope: 'personal', total: 1 })
  })
})
