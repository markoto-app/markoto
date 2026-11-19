// Which project-context documents reach a reader. Candidates come from the
// repo; each is decided on its own through the document access proof, so a
// guest or another member only ever gets what they could open themselves.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { deliberatelyInvalid } from '../../helpers/fixtures'

import {
  findProjectContextDoc,
  listProjectContext,
  listReadableContextLinks,
  resolveProjectContext
} from '../../../server/utils/documents/projectContext'
import { getContextDocTitle, listContextCandidates, listContextLinks } from '../../../server/repos/projectContext'
import { getIndexedText } from '../../../server/repos/documentSearch'
import { proveDocNeed } from '../../../server/utils/access/docProof'
import { MAX_CONTEXT_DOCS } from '../../../shared/config/projectContext'
import { docAs } from '../../helpers/access'

vi.mock('../../../server/repos/projectContext', () => ({
  getContextDocTitle: vi.fn(),
  listContextCandidates: vi.fn(),
  listContextLinks: vi.fn()
}))
vi.mock('../../../server/repos/documentSearch', () => ({ getIndexedText: vi.fn() }))
vi.mock('../../../server/utils/access/docProof', () => ({ proveDocNeed: vi.fn() }))

const cand = (docId: string, source: 'all' | 'folder' | 'link' = 'all') => deliberatelyInvalid({ docId, source })
const current = docAs('cur', 7)

/** Only these documents are openable for the reader. */
function readable(ids: string[]) {
  vi.mocked(proveDocNeed).mockImplementation(async (_u, docId) => (ids.includes(docId) ? docAs(docId, 7) as never : null))
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getContextDocTitle).mockImplementation(async access => `Title of ${(access as { docId: string }).docId}`)
})

describe('listProjectContext', () => {
  it('leaves out documents the reader may not open, without a trace', async () => {
    vi.mocked(listContextCandidates).mockResolvedValue([cand('bible'), cand('hr-secrets', 'folder'), cand('glossary', 'link')])
    readable(['bible', 'glossary'])
    const { entries, omitted } = await listProjectContext(current, 7)
    expect(entries.map(e => e.docId)).toEqual(['bible', 'glossary'])
    expect(entries.map(e => e.source)).toEqual(['all', 'link'])
    expect(omitted).toBe(0)
  })

  it('asks the access layer per candidate for the reader, as for opening its URL', async () => {
    vi.mocked(listContextCandidates).mockResolvedValue([cand('bible')])
    readable(['bible'])
    await listProjectContext(current, 42)
    expect(proveDocNeed).toHaveBeenCalledWith(42, 'bible', 'file')
  })

  it('a guest without a share gets nothing', async () => {
    vi.mocked(listContextCandidates).mockResolvedValue([cand('bible'), cand('style')])
    readable([])
    expect(await listProjectContext(current, 99)).toEqual({ entries: [], omitted: 0 })
  })

  it('caps the list and reports how many readable documents were left out', async () => {
    const ids = Array.from({ length: MAX_CONTEXT_DOCS + 3 }, (_, i) => `d${i}`)
    vi.mocked(listContextCandidates).mockResolvedValue(ids.map(id => cand(id)))
    readable(ids)
    const { entries, omitted } = await listProjectContext(current, 7)
    expect(entries).toHaveLength(MAX_CONTEXT_DOCS)
    expect(entries[0]?.docId).toBe('d0')
    expect(omitted).toBe(3)
  })

  it('unreadable documents do not count against the cap or the omitted number', async () => {
    const ids = Array.from({ length: MAX_CONTEXT_DOCS + 2 }, (_, i) => `d${i}`)
    vi.mocked(listContextCandidates).mockResolvedValue(ids.map(id => cand(id)))
    readable(ids.slice(0, MAX_CONTEXT_DOCS))
    const { entries, omitted } = await listProjectContext(current, 7)
    expect(entries).toHaveLength(MAX_CONTEXT_DOCS)
    expect(omitted).toBe(0)
  })

  it('falls back to an empty title when none is stored', async () => {
    vi.mocked(listContextCandidates).mockResolvedValue([cand('bible')])
    readable(['bible'])
    vi.mocked(getContextDocTitle).mockResolvedValue(null as never)
    expect((await listProjectContext(current, 7)).entries[0]?.title).toBe('')
  })
})

describe('resolveProjectContext', () => {
  it('adds the indexed body and its fresher title; a never-stored document has an empty body', async () => {
    vi.mocked(listContextCandidates).mockResolvedValue([cand('bible'), cand('blank')])
    readable(['bible', 'blank'])
    vi.mocked(getIndexedText).mockImplementation(async access => ((access as { docId: string }).docId === 'bible' ? { title: 'Story bible', body: 'Mara is 34.' } : null) as never)
    const { entries } = await resolveProjectContext(current, 7)
    expect(entries[0]).toMatchObject({ docId: 'bible', title: 'Story bible', body: 'Mara is 34.' })
    expect(entries[1]).toMatchObject({ docId: 'blank', title: 'Title of blank', body: '' })
  })
})

describe('findProjectContextDoc', () => {
  it('finds a readable context document with its body', async () => {
    vi.mocked(listContextCandidates).mockResolvedValue([cand('bible')])
    readable(['bible'])
    vi.mocked(getIndexedText).mockResolvedValue(deliberatelyInvalid({ title: 'Story bible', body: 'Text' }))
    expect(await findProjectContextDoc(current, 7, 'bible')).toMatchObject({ docId: 'bible', title: 'Story bible', body: 'Text' })
  })

  it('refuses a document that is no context document of this one, even if the reader could open it', async () => {
    vi.mocked(listContextCandidates).mockResolvedValue([cand('bible')])
    readable(['bible', 'other-doc'])
    expect(await findProjectContextDoc(current, 7, 'other-doc')).toBeNull()
    expect(getIndexedText).not.toHaveBeenCalled()
  })

  it('refuses a context document the reader cannot open', async () => {
    vi.mocked(listContextCandidates).mockResolvedValue([cand('bible')])
    readable([])
    expect(await findProjectContextDoc(current, 7, 'bible')).toBeNull()
  })

  it('falls back to the listed title and an empty body without indexed text', async () => {
    vi.mocked(listContextCandidates).mockResolvedValue([cand('bible')])
    readable(['bible'])
    vi.mocked(getIndexedText).mockResolvedValue(null as never)
    expect(await findProjectContextDoc(current, 7, 'bible')).toMatchObject({ title: 'Title of bible', body: '' })
  })
})

describe('listReadableContextLinks', () => {
  it('lists attached documents the reader may open and counts the hidden ones', async () => {
    vi.mocked(listContextLinks).mockResolvedValue(['a', 'b', 'c'])
    readable(['a', 'c'])
    expect(await listReadableContextLinks(current, 7)).toEqual({
      links: [{ docId: 'a', title: 'Title of a' }, { docId: 'c', title: 'Title of c' }],
      hidden: 1
    })
  })

  it('shows nothing and hides nothing when no document is attached', async () => {
    vi.mocked(listContextLinks).mockResolvedValue([])
    expect(await listReadableContextLinks(current, 7)).toEqual({ links: [], hidden: 0 })
  })

  it('uses an empty title when the stored one is missing', async () => {
    vi.mocked(listContextLinks).mockResolvedValue(['a'])
    readable(['a'])
    vi.mocked(getContextDocTitle).mockResolvedValue(null as never)
    expect((await listReadableContextLinks(current, 7)).links[0]?.title).toBe('')
  })
})
