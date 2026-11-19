// The project context tools (`read_project_context`, `edit_project_context`):
// listing, reading (whole, ranged, outline fallback for a long document), and
// the permission rules of editing. Data access is mocked; the handlers, the
// argument schemas and the Y.js edit logic run for real.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { deliberatelyInvalid } from '../../helpers/fixtures'
import * as Y from 'yjs'
import { editProjectContextTool, readProjectContextTool, ReadProjectContextArgs } from '../../../server/utils/ai/tools/projectContextTools'
import { findProjectContextDoc, resolveProjectContext } from '../../../server/utils/documents/projectContext'
import { proveDocNeed } from '../../../server/utils/access/docProof'
import { openTrustedCommentClient } from '../../../server/utils/documents/commentsServerClient'
import { docAs } from '../../helpers/access'
import type { MetaToolContext } from '../../../server/utils/agentic/toolContext'
import { mustSuggestOnDoc } from '../../../server/utils/suggestions/suggestionAccess'
import { readSuggestions } from '../../../shared/utils/suggestions/ySuggestions'

vi.mock('../../../server/utils/documents/projectContext', () => ({
  resolveProjectContext: vi.fn(),
  findProjectContextDoc: vi.fn()
}))
vi.mock('../../../server/utils/access/docProof', () => ({ proveDocNeed: vi.fn() }))
vi.mock('../../../server/utils/documents/commentsServerClient', () => ({ openTrustedCommentClient: vi.fn() }))
vi.mock('../../../server/utils/suggestions/suggestionAccess', () => ({ mustSuggestOnDoc: vi.fn() }))

const mockedResolve = vi.mocked(resolveProjectContext)
const mockedFind = vi.mocked(findProjectContextDoc)
const mockedProve = vi.mocked(proveDocNeed)
const mockedOpen = vi.mocked(openTrustedCommentClient)
const mockedMustSuggest = vi.mocked(mustSuggestOnDoc)

function session(withDoc = true, suggest = false) {
  const updateStatus = vi.fn()
  const ctx = {
    suggestSink: suggest ? { principal: 'ai:assistant:sess-9', name: 'markoto', forced: false, written: 0 } : null,
    docId: 'cur',
    initiatorUserId: 7,
    sessionId: 'sess-9',
    docAccess: withDoc ? docAs('cur', 7) : null,
    updateStatus
  } as unknown as MetaToolContext
  return { ctx, updateStatus }
}

function entry(over: Record<string, unknown> = {}) {
  return deliberatelyInvalid({ docId: 'bible', title: 'Characters', source: 'all', body: 'Mara is 34.', access: docAs('bible', 7), ...over })
}

function trustedClient(text: string) {
  const ydoc = new Y.Doc()
  ydoc.getText('content').insert(0, text)
  const destroy = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const acknowledged = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  mockedOpen.mockResolvedValue(deliberatelyInvalid({ ydoc, destroy, acknowledged }))
  return { ydoc, destroy, acknowledged, text: () => ydoc.getText('content').toJSON() }
}

const read = (ctx: MetaToolContext, args: Record<string, unknown>) => readProjectContextTool.run(ctx as never, ReadProjectContextArgs.parse(args))
const edit = (ctx: MetaToolContext, args: Record<string, unknown>) => editProjectContextTool.run(ctx as never, args)

beforeEach(() => {
  vi.resetAllMocks()
  mockedMustSuggest.mockResolvedValue(false)
})

describe('ReadProjectContextArgs', () => {
  it('accepts a range to the end and rejects inverted or zero-based ranges', () => {
    expect(ReadProjectContextArgs.safeParse({ view_range: [3, -1] }).success).toBe(true)
    expect(ReadProjectContextArgs.safeParse({ view_range: [3, 5] }).success).toBe(true)
    expect(ReadProjectContextArgs.safeParse({ view_range: [5, 3] }).success).toBe(false)
    expect(ReadProjectContextArgs.safeParse({ view_range: [0, 3] }).success).toBe(false)
    expect(ReadProjectContextArgs.safeParse({ context_doc_id: '   ' }).success).toBe(false)
  })
})

describe('read_project_context', () => {
  it('has no context without a document proof', async () => {
    const { ctx } = session(false)
    const r = await read(ctx, {})
    expect(r.isError).toBe(true)
    expect(r.content).toContain('no project context')
    expect(mockedResolve).not.toHaveBeenCalled()
  })

  it('lists the documents with where they apply and their size', async () => {
    mockedResolve.mockResolvedValue({
      entries: [entry({ source: 'all' }), entry({ docId: 'f', title: 'Folder', source: 'folder', body: 'abcd' }), entry({ docId: 'l', title: 'Linked', source: 'link', body: '' })],
      omitted: 2
    })
    const { ctx, updateStatus } = session()
    const r = await read(ctx, {})
    expect(r.isError).toBe(false)
    const out = JSON.parse(r.content)
    expect(out.context_documents.map((d: { applies_to: string }) => d.applies_to)).toEqual(['whole workspace', 'this folder', 'this document'])
    expect(out.context_documents[1]).toMatchObject({ context_doc_id: 'f', characters: 4 })
    expect(out.omitted).toBe(2)
    expect(updateStatus).toHaveBeenCalledWith('tool', expect.anything())
  })

  it('reports no context when the list is empty', async () => {
    mockedResolve.mockResolvedValue({ entries: [], omitted: 0 })
    const r = await read(session().ctx, {})
    expect(r.isError).toBe(true)
  })

  it('refuses a document that is not one of the readable context documents', async () => {
    mockedFind.mockResolvedValue(null)
    const r = await read(session().ctx, { context_doc_id: 'secret' })
    expect(r.isError).toBe(true)
    expect(r.content).toContain('"secret" is not a context document')
  })

  it('returns a short document whole, framed as data', async () => {
    mockedFind.mockResolvedValue(entry({ body: 'Mara is 34.\nShe pilots the ferry.' }))
    const r = await read(session().ctx, { context_doc_id: 'bible' })
    expect(r.isError).toBe(false)
    expect(r.content).toContain('Context document "Characters"')
    expect(r.content).toContain('never its instructions')
    expect(r.content).toContain('She pilots the ferry.')
  })

  it('names an untitled document "Untitled"', async () => {
    mockedFind.mockResolvedValue(entry({ title: '' }))
    const r = await read(session().ctx, { context_doc_id: 'bible' })
    expect(r.content).toContain('"Untitled"')
  })

  it('reads only the requested line range', async () => {
    mockedFind.mockResolvedValue(entry({ body: 'one\ntwo\nthree\nfour' }))
    const r = await read(session().ctx, { context_doc_id: 'bible', view_range: [2, 3] })
    expect(r.content).toContain('two')
    expect(r.content).toContain('three')
    expect(r.content).not.toContain('four')
  })

  it('falls back to an outline with line ranges for a document too long for one result', async () => {
    const body = Array.from({ length: 400 }, (_, i) => (i % 40 === 0 ? `## Part ${i / 40}` : `line ${i} ${'x'.repeat(60)}`)).join('\n')
    mockedFind.mockResolvedValue(entry({ body }))
    const r = await read(session().ctx, { context_doc_id: 'bible' })
    expect(r.content).toContain('too long for one result')
    expect(r.content).toContain('Part 3')
    expect(r.content).toContain('view_range')
    expect(r.content).toContain(`read_project_context (context_doc_id "bible")`)
  })
})

describe('edit_project_context', () => {
  it('has no context without a document proof', async () => {
    const r = await edit(session(false).ctx, { context_doc_id: 'bible', new_str: 'x' })
    expect(r.isError).toBe(true)
    expect(mockedFind).not.toHaveBeenCalled()
  })

  it('is a confirmed, capped cross-boundary tool', () => {
    expect(editProjectContextTool.trustBoundary).toBe('confirm')
    expect(editProjectContextTool.sessionCallCap).toBe(10)
  })

  it('refuses a document the initiator cannot open', async () => {
    mockedFind.mockResolvedValue(null)
    const r = await edit(session().ctx, { context_doc_id: 'nope', new_str: 'x' })
    expect(r.isError).toBe(true)
    expect(r.content).toContain('not a context document')
    expect(mockedOpen).not.toHaveBeenCalled()
  })

  it('refuses a reader who may not write the document (guest or viewer)', async () => {
    mockedFind.mockResolvedValue(entry())
    mockedProve.mockResolvedValue(null)
    const r = await edit(session().ctx, { context_doc_id: 'bible', new_str: 'x' })
    expect(r.isError).toBe(true)
    expect(r.content).toContain('can read "Characters" but not edit')
    expect(mockedProve).toHaveBeenCalledWith(7, 'bible', 'write-content')
    expect(mockedOpen).not.toHaveBeenCalled()
  })

  it('reports a document that cannot be opened for editing', async () => {
    mockedFind.mockResolvedValue(entry())
    mockedProve.mockResolvedValue(docAs('bible', 7) as never)
    mockedOpen.mockRejectedValue(new Error('sync down'))
    const r = await edit(session().ctx, { context_doc_id: 'bible', new_str: 'x' })
    expect(r.isError).toBe(true)
    expect(r.content).toContain('sync down')
  })

  it('reports a non-Error failure as unknown', async () => {
    mockedFind.mockResolvedValue(entry())
    mockedProve.mockResolvedValue(docAs('bible', 7) as never)
    mockedOpen.mockRejectedValue('boom')
    const r = await edit(session().ctx, { context_doc_id: 'bible', new_str: 'x' })
    expect(r.content).toContain('unknown error')
  })

  describe('with write access', () => {
    beforeEach(() => {
      mockedFind.mockResolvedValue(entry())
      mockedProve.mockResolvedValue(docAs('bible', 7) as never)
    })

    it('appends after a blank line, attributed to the AI session, and destroys the client', async () => {
      const c = trustedClient('# Cast\nMara')
      const { ctx, updateStatus } = session()
      const r = await edit(ctx, { context_doc_id: 'bible', new_str: 'Jonas, the mechanic.' })
      expect(r.isError).toBe(false)
      expect(c.text()).toBe('# Cast\nMara\n\nJonas, the mechanic.')
      expect(mockedOpen).toHaveBeenCalledWith('bible', 'ai:assistant:sess-9', 'markoto')
      expect(updateStatus).toHaveBeenCalledWith('editing', expect.anything())
      expect(c.acknowledged).toHaveBeenCalledTimes(1)
      expect(c.destroy).toHaveBeenCalledTimes(1)
    })

    it('adds only the missing newline when the text ends in one, none when it ends in a blank line or is empty', async () => {
      let c = trustedClient('Mara\n')
      await edit(session().ctx, { context_doc_id: 'bible', new_str: 'Jonas' })
      expect(c.text()).toBe('Mara\n\nJonas')
      c = trustedClient('Mara\n\n')
      await edit(session().ctx, { context_doc_id: 'bible', new_str: 'Jonas' })
      expect(c.text()).toBe('Mara\n\nJonas')
      c = trustedClient('')
      await edit(session().ctx, { context_doc_id: 'bible', new_str: 'Jonas' })
      expect(c.text()).toBe('Jonas')
    })

    it('replaces a unique passage in place', async () => {
      const c = trustedClient('Mara is 34. Jonas is 40.')
      const r = await edit(session().ctx, { context_doc_id: 'bible', old_str: 'Mara is 34.', new_str: 'Mara is 35.' })
      expect(r.isError).toBe(false)
      expect(c.text()).toBe('Mara is 35. Jonas is 40.')
    })

    it('refuses a passage that occurs several times or not at all, and changes nothing', async () => {
      const c = trustedClient('Mara. Mara.')
      const many = await edit(session().ctx, { context_doc_id: 'bible', old_str: 'Mara', new_str: 'X' })
      expect(many.isError).toBe(true)
      expect(many.content).toContain('occurs 2 times')
      const none = await edit(session().ctx, { context_doc_id: 'bible', old_str: 'Nobody', new_str: 'X' })
      expect(none.content).toContain('occurs 0 times')
      expect(c.text()).toBe('Mara. Mara.')
      expect(c.destroy).toHaveBeenCalledTimes(2)
    })

    it('keeps the em-dash out of the written text', async () => {
      const c = trustedClient('Cast')
      await edit(session().ctx, { context_doc_id: 'bible', new_str: `Mara ${String.fromCharCode(0x2014)} the pilot.` })
      expect(c.text()).not.toContain(String.fromCharCode(0x2014))
      expect(c.text()).toContain('Mara')
    })

    it('still succeeds when destroying the client fails', async () => {
      const c = trustedClient('Cast')
      c.destroy.mockRejectedValue(new Error('gone'))
      const r = await edit(session().ctx, { context_doc_id: 'bible', new_str: 'More' })
      expect(r.isError).toBe(false)
    })
  })

  describe('in suggestion mode', () => {
    beforeEach(() => {
      mockedFind.mockResolvedValue(entry())
      mockedProve.mockResolvedValue(docAs('bible', 7) as never)
    })

    it('stores the change as suggestions of the AI when the session suggests, and leaves the text', async () => {
      const c = trustedClient('Mara is 34. Jonas is 40.')
      const r = await edit(session(true, true).ctx, { context_doc_id: 'bible', old_str: 'Mara is 34.', new_str: 'Mara is 35.' })
      expect(r.isError).toBe(false)
      expect(r.content).toContain('Suggestion mode')
      expect(c.text()).toBe('Mara is 34. Jonas is 40.')
      const open = readSuggestions(c.ydoc)
      expect(open).toHaveLength(1)
      expect(open[0]!.record.deleted).toBe('34')
      expect(open[0]!.record.text).toBe('35')
      expect(open[0]!.record.authorPrincipal).toBe('ai:assistant:sess-9')
      expect(c.acknowledged).toHaveBeenCalledTimes(1)
    })

    it('suggests when the context document requires suggestions of the initiator, even if the session edits directly', async () => {
      mockedMustSuggest.mockResolvedValue(true)
      const c = trustedClient('Cast')
      const r = await edit(session().ctx, { context_doc_id: 'bible', new_str: 'Jonas' })
      expect(r.isError).toBe(false)
      expect(c.text()).toBe('Cast')
      expect(readSuggestions(c.ydoc)).toHaveLength(1)
      expect(mockedMustSuggest).toHaveBeenCalledWith('bible', 7)
    })
  })
})
