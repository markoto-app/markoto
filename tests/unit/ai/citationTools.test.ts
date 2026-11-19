import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'

import { addReferenceByDoiTool, checkCitationsTool, listReferencesTool, titleMatch } from '../../../server/utils/ai/tools/citationTools'
import { DoiLookupError } from '../../../server/utils/citations/crossref'
import { serializeItem } from '../../../shared/utils/citations/cslItem'
import { BIBLIOGRAPHY_ROOT } from '../../../shared/utils/citations/docBibliography'

const lookupMock = vi.hoisted(() => vi.fn())
vi.mock('../../../server/utils/citations/crossref', async () => {
  const actual = await vi.importActual<typeof import('../../../server/utils/citations/crossref')>('../../../server/utils/citations/crossref')
  return { ...actual, lookupDoi: (...a: unknown[]) => lookupMock(...a) }
})

type Ctx = Parameters<typeof listReferencesTool.run>[0] & { ydoc: Y.Doc }

function makeCtx(text = '') {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('content')
  ytext.insert(0, text)
  const status = vi.fn()
  const ctx: unknown = { ydoc, ytext, ymeta: ydoc.getMap('meta'), sessionId: 's1', updateStatus: status }
  return ctx as Ctx
}

const smith = { id: 'smith2020study', type: 'article-journal', title: 'A Study of Things', author: [{ family: 'Smith', given: 'John' }], issued: { 'date-parts': [[2020]] }, DOI: '10.1000/xyz123' }
const knuth = { id: 'knuth1984book', type: 'book', title: 'The TeXbook', author: [{ family: 'Knuth', given: 'Donald' }], issued: { 'date-parts': [[1984]] } }

function seed(ctx: { ydoc: Y.Doc }, ...items: Array<Record<string, unknown>>) {
  const map = ctx.ydoc.getMap<unknown>(BIBLIOGRAPHY_ROOT)
  for (const i of items) map.set(i.id as string, serializeItem(i as never))
}

describe('titleMatch', () => {
  it('scores overlap of significant words, ignoring case and accents', () => {
    expect(titleMatch('A Study of Things', 'a study of THINGS')).toBe(1)
    expect(titleMatch('Étude sur les choses', 'Etude sur les choses')).toBe(1)
    expect(titleMatch('Study of Things', 'Something else entirely')).toBe(0)
    expect(titleMatch('Quantum Study Things', 'A Study of Things')).toBeCloseTo(2 / 3)
  })
  it('is 0 for an empty expected title', () => {
    expect(titleMatch('a of', 'anything')).toBe(0)
  })
})

describe('list_references', () => {
  it('says so when the bibliography is empty', async () => {
    const r = await listReferencesTool.run(makeCtx(), {})
    expect(r.isError).toBe(false)
    expect(r.content).toContain('bibliography is empty')
  })

  it('lists entries with key and DOI, and filters by query words', async () => {
    const ctx = makeCtx()
    seed(ctx, smith, knuth)
    const all = await listReferencesTool.run(ctx, {})
    expect(all.content).toContain('2 of 2 entries')
    expect(all.content).toContain('@smith2020study')
    expect(all.content).toContain('(DOI 10.1000/xyz123)')
    const some = await listReferencesTool.run(ctx, { query: 'knuth book' })
    expect(some.content).toContain('1 of 2 entries')
    expect(some.content).toContain('@knuth1984book')
    expect(some.content).not.toContain('@smith2020study')
    const none = await listReferencesTool.run(ctx, { query: 'zzz' })
    expect(none.content).toContain('0 of 2 entries')
  })
})

describe('add_reference_by_doi', () => {
  beforeEach(() => {
    lookupMock.mockReset()
  })

  it('adds a verified work and returns its key', async () => {
    const ctx = makeCtx()
    lookupMock.mockResolvedValue(smith)
    const r = await addReferenceByDoiTool.run(ctx, { doi: '10.1000/xyz123', expected_title: 'A Study of Things' })
    expect(r.isError).toBe(false)
    expect(r.content).toContain('Added (verified at Crossref)')
    expect(r.content).toContain('[@smith2020study]')
    expect((ctx as never as { ydoc: Y.Doc }).ydoc.getMap(BIBLIOGRAPHY_ROOT).has('smith2020study')).toBe(true)
  })

  it('passes a key-taken probe that sees the bibliography', async () => {
    const ctx = makeCtx()
    seed(ctx, knuth)
    lookupMock.mockImplementation(async (_doi: string, taken: (k: string) => boolean) => {
      expect(taken('knuth1984book')).toBe(true)
      expect(taken('nope')).toBe(false)
      return smith
    })
    await addReferenceByDoiTool.run(ctx, { doi: '10.1000/xyz123', expected_title: 'A Study of Things' })
    expect(lookupMock).toHaveBeenCalled()
  })

  it.each([
    ['invalid', 'not a DOI'],
    ['not-found', 'no record of this DOI'],
    ['unavailable', 'lookup at Crossref failed']
  ] as const)('refuses on %s and adds nothing', async (why, msg) => {
    const ctx = makeCtx()
    lookupMock.mockRejectedValue(new DoiLookupError(why))
    const r = await addReferenceByDoiTool.run(ctx, { doi: 'x', expected_title: 'Whatever' })
    expect(r.isError).toBe(true)
    expect(r.content).toContain(msg)
    expect((ctx as never as { ydoc: Y.Doc }).ydoc.getMap(BIBLIOGRAPHY_ROOT).size).toBe(0)
  })

  it('rethrows unexpected errors', async () => {
    lookupMock.mockRejectedValue(new Error('boom'))
    await expect(addReferenceByDoiTool.run(makeCtx(), { doi: 'x', expected_title: 'y' })).rejects.toThrow('boom')
  })

  it('refuses when the title does not match the DOI', async () => {
    const ctx = makeCtx()
    lookupMock.mockResolvedValue(smith)
    const r = await addReferenceByDoiTool.run(ctx, { doi: '10.1000/xyz123', expected_title: 'Completely Different Paper Title' })
    expect(r.isError).toBe(true)
    expect(r.content).toContain('does not match')
    expect((ctx as never as { ydoc: Y.Doc }).ydoc.getMap(BIBLIOGRAPHY_ROOT).size).toBe(0)
  })

  it('returns the existing key for a DOI already in the bibliography', async () => {
    const ctx = makeCtx()
    seed(ctx, { ...smith, id: 'existing1' })
    lookupMock.mockResolvedValue(smith)
    const r = await addReferenceByDoiTool.run(ctx, { doi: '10.1000/XYZ123', expected_title: 'A Study of Things' })
    expect(r.isError).toBe(false)
    expect(r.content).toContain('Already in the bibliography as @existing1')
    expect((ctx as never as { ydoc: Y.Doc }).ydoc.getMap(BIBLIOGRAPHY_ROOT).size).toBe(1)
  })

  it('is capped and gated on the trust boundary', () => {
    expect(addReferenceByDoiTool.sessionCallCap).toBe(10)
    expect(addReferenceByDoiTool.trustBoundary).toBe('confirm')
  })
})

describe('check_citations', () => {
  it('reports a clean document', async () => {
    const ctx = makeCtx('Plain text {#fig:a} see @fig:a and [@smith2020study].')
    seed(ctx, smith)
    const r = await checkCitationsTool.run(ctx, {})
    expect(r.content).toContain('Every citation has a bibliography entry.')
    expect(r.content).toContain('Every cross-reference has its label.')
    expect(r.content).toContain('Every entry is cited.')
  })

  it('reports missing keys, missing labels and unused entries', async () => {
    const ctx = makeCtx('Claim [@ghost2001]. See @fig:nowhere and @sec:intro. Mention @someone.\n\n## Intro {#sec:intro}')
    seed(ctx, smith)
    const r = await checkCitationsTool.run(ctx, {})
    expect(r.content).toContain('Cited but not in the bibliography (shown as broken markers): @ghost2001')
    expect(r.content).not.toContain('@someone,')
    expect(r.content).toContain('labels that do not exist: @fig:nowhere')
    expect(r.content).not.toContain('@sec:intro')
    expect(r.content).toContain('never cited (not printed): @smith2020study')
  })
})
