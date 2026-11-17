import { describe, it, expect, vi } from 'vitest'
import * as Y from 'yjs'
import { executeFunctionByName } from '../../../server/utils/ai/tools/registry'
import type { AiSession } from '../../../server/utils/ai/aiClient'
import { boundedDocumentView, documentOutline, formatOutline } from '../../../server/utils/ai/tools/documentText'
import { capToolOutput } from '../../../server/utils/agentic/loop/resultCap'
import { TOOL_RESULT_CHAR_CAP } from '../../../server/utils/agentic/limits'
import { generateLargeDocument } from '../../fixtures/largeDocument/generate'
import { defaultTheme } from '../../../shared/utils/theme/defaultTheme'

// Tool results stay bounded: the loop's central cap with continuation
// hints, view_document's outline for long documents and ranged reads that
// say where to continue, read_comments and list_themes.

const { listThemesByUser } = vi.hoisted(() => ({ listThemesByUser: vi.fn() }))
vi.mock('../../../server/repos/themes', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../server/repos/themes')>()),
  listThemesByUser
}))

function makeSession(initial: string): { session: AiSession, ydoc: Y.Doc } {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('content')
  if (initial) ytext.insert(0, initial)
  const session = {
    ydoc,
    ytext,
    ymeta: ydoc.getMap('meta'),
    awareness: null as never,
    provider: null as never,
    sessionId: 's1',
    initiatorUserId: 1,
    updateStatus: vi.fn(),
    destroy: async () => {}
  } as unknown as AiSession
  return { session, ydoc }
}

const large = generateLargeDocument()
const largeLines = large.split('\n')

describe('capToolOutput (loop result cap)', () => {
  it('leaves results within the cap alone', () => {
    expect(capToolOutput('fetch_url', {}, 'short')).toBe('short')
  })

  it('cuts at a line break and names the rest of the size', () => {
    const output = Array.from({ length: 2000 }, (_, i) => `row ${i} ${'x'.repeat(40)}`).join('\n')
    const capped = capToolOutput('web_search', {}, output)
    expect(capped.length).toBeLessThanOrEqual(TOOL_RESULT_CHAR_CAP)
    expect(capped).toMatch(/\[Result cut at \d+ of \d+ characters \(tool result size limit\)\. Ask for less at once/)
    const lastKept = capped.split('\n\n[Result cut')[0]!.split('\n').pop()!
    expect(lastKept).toMatch(/^row \d+ x{40}$/)
  })

  it('tells view_document where to continue', () => {
    const output = Array.from({ length: 1000 }, (_, i) => `${i + 10}: ${'y'.repeat(60)}`).join('\n')
    const capped = capToolOutput('view_document', { view_range: [10, 1009] }, output, 5_000)
    const lastNo = Number(/(\d+): y+\n\n\[Result cut/.exec(capped)![1])
    expect(capped).toContain(`Continue with view_document and view_range [${lastNo + 1}, `)
  })

  it('tells view_other_document which doc and range to read next', () => {
    const output = Array.from({ length: 1000 }, (_, i) => `${i + 1}: ${'z'.repeat(60)}`).join('\n')
    const capped = capToolOutput('view_other_document', { doc_id: 'abc123' }, output, 5_000)
    expect(capped).toMatch(/Continue with view_other_document \(doc_id "abc123"\) and view_range \[\d+, \d+\]/)
  })

  it('points get_knowledge_file to search_knowledge', () => {
    const capped = capToolOutput('get_knowledge_file', {}, 'k'.repeat(30_000))
    expect(capped).toContain('search_knowledge')
  })
})

describe('documentOutline', () => {
  it('lists headings with section line ranges and skips fenced code', () => {
    const doc = [
      '# One', // 1
      'text', // 2
      '## One.A', // 3
      '```bash', // 4
      '# not a heading', // 5
      '```', // 6
      '## One.B', // 7
      '# Two', // 8
      'end' // 9
    ].join('\n')
    expect(documentOutline(doc).map(e => [e.line, e.endLine, e.level, e.heading])).toEqual([
      [1, 7, 1, '# One'],
      [3, 6, 2, '## One.A'],
      [7, 7, 2, '## One.B'],
      [8, 9, 1, '# Two']
    ])
  })

  it('drops deeper levels when the outline would not fit', () => {
    const entries = documentOutline(large)
    const text = formatOutline(entries, 8_000)
    expect(text.length).toBeLessThan(8_200)
    expect(text).toMatch(/^\[\d+-\d+\] # /m)
    expect(text).not.toMatch(/^\[\d+-\d+\] ### /m)
    expect(text).toMatch(/deeper headings not listed/)
  })

  it('ignores the `#` lines inside the fixture\'s code block', () => {
    const entries = documentOutline(large)
    for (const e of entries) expect(largeLines[e.line - 1]).toBe(e.heading)
    const inFence = new Set<number>()
    let open = false
    largeLines.forEach((l, i) => {
      if (l.startsWith('```')) open = !open
      else if (open) inFence.add(i + 1)
    })
    const fencedHashLines = [...inFence].filter(n => largeLines[n - 1]!.startsWith('#'))
    expect(fencedHashLines.length).toBeGreaterThan(0)
    for (const n of fencedHashLines) expect(entries.some(e => e.line === n)).toBe(false)
  })
})

describe('view_document on a long document', () => {
  it('returns the outline and the first lines instead of everything', async () => {
    const { session } = makeSession(large)
    const res = await executeFunctionByName(session, 'view_document', {})
    expect(res.isError).toBe(false)
    expect(res.content.length).toBeLessThanOrEqual(TOOL_RESULT_CHAR_CAP)
    expect(res.content).toContain(`The document has ${largeLines.length} lines`)
    expect(res.content).toMatch(/\[\d+-\d+\] # 1 /)
    expect(res.content).toMatch(/view_range \[start, end\]; about \d+ lines fit in one call/)
    const firstPart = /Lines 1-(\d+) follow:\n\n/.exec(res.content)
    expect(firstPart).not.toBeNull()
    expect(res.content).toContain(`1: ${largeLines[0]}`)
  })

  it('a ranged read over the budget says which range continues it', async () => {
    const { session } = makeSession(large)
    const res = await executeFunctionByName(session, 'view_document', { view_range: [1, 2000] })
    expect(res.content.length).toBeLessThanOrEqual(TOOL_RESULT_CHAR_CAP)
    const m = /Shown: lines 1-(\d+) of the requested 1-2000 \(result size limit\)\. Continue with view_document and view_range \[(\d+), (\d+)\]\./.exec(res.content)
    expect(m).not.toBeNull()
    expect(Number(m![2])).toBe(Number(m![1]) + 1)
    // The continuation reads on without a gap.
    const next = await executeFunctionByName(session, 'view_document', { view_range: [Number(m![2]), Number(m![3])] })
    expect(next.content.startsWith(`${m![2]}: ${largeLines[Number(m![2]) - 1]}`)).toBe(true)
  })

  it('short documents and ranges that fit come back unchanged', async () => {
    const { session } = makeSession(large)
    const res = await executeFunctionByName(session, 'view_document', { view_range: [3, 5] })
    expect(res.content).toBe(`3: ${largeLines[2]}\n4: ${largeLines[3]}\n5: ${largeLines[4]}`)
  })

  it('a range past the end says how long the document is', async () => {
    const { session } = makeSession('a\nb')
    const res = await executeFunctionByName(session, 'view_document', { view_range: [5, 10] })
    expect(res.isError).toBe(false)
    expect(res.content).toContain('only 2 lines')
  })

  it('a single line longer than the budget is cut, not dropped', () => {
    const out = boundedDocumentView('x'.repeat(5_000), [1, 1], 1_000, 'view_document')
    expect(out).toContain('[line cut]')
    expect(out).toContain('longer than one result allows')
  })
})

describe('list_themes is bounded', () => {
  it('shortens long custom CSS and lists themes past the budget by name only', async () => {
    const theme = { ...defaultTheme, customCss: `.a { color: red; }\n${'/* pad */\n'.repeat(3_000)}` }
    listThemesByUser.mockResolvedValue(Array.from({ length: 20 }, (_, i) => ({ themeId: `t${i}`, name: `Theme ${i}`, description: null, theme })))
    const { session } = makeSession('doc')
    const res = await executeFunctionByName(session, 'list_themes', {})
    expect(res.isError).toBe(false)
    expect(res.content.length).toBeLessThanOrEqual(TOOL_RESULT_CHAR_CAP)
    const payload = JSON.parse(res.content) as { savedThemes: Array<{ theme_id: string, theme: { customCss?: string } | null }>, notes: string[] }
    expect(payload.savedThemes).toHaveLength(20)
    expect(payload.savedThemes[0]!.theme!.customCss).toContain('more characters not shown here')
    expect(payload.savedThemes.some(t => t.theme === null)).toBe(true)
    expect(payload.notes.join(' ')).toContain('did not fit in this result')
  })

  it('a small list stays pretty-printed in full', async () => {
    listThemesByUser.mockResolvedValue([{ themeId: 't1', name: 'One', description: null, theme: defaultTheme }])
    const { session } = makeSession('doc')
    const res = await executeFunctionByName(session, 'list_themes', {})
    expect(res.content).toContain('\n  "savedThemes": [')
    expect(JSON.parse(res.content).savedThemes[0].theme).toEqual(defaultTheme)
  })
})

describe('read_comments is bounded', () => {
  it('lists threads past the budget one line each', async () => {
    const { session, ydoc } = makeSession('line one\nline two')
    const comments = ydoc.getArray<Y.Map<unknown>>('comments')
    ydoc.transact(() => {
      for (let i = 0; i < 20; i++) {
        const m = new Y.Map<unknown>()
        m.set('id', `c${i}`)
        m.set('body', `Comment ${i} `.repeat(300))
        m.set('authorName', 'Ann')
        m.set('createdAt', 0)
        m.set('resolved', false)
        m.set('anchorStart', null)
        m.set('anchorEnd', null)
        comments.push([m])
      }
    })
    const res = await executeFunctionByName(session, 'read_comments', {})
    expect(res.isError).toBe(false)
    expect(res.content.length).toBeLessThanOrEqual(TOOL_RESULT_CHAR_CAP)
    expect(res.content).toContain('--- Thread c0 ---')
    expect(res.content).toMatch(/more thread\(s\) did not fit in full/)
    expect(res.content).toContain('- Thread c19, orphaned, by Ann, 0 replies')
  })
})
