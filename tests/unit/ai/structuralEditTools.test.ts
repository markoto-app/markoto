import { describe, it, expect, vi } from 'vitest'
import * as Y from 'yjs'
import { executeFunctionByName, toolSchema } from '../../../server/utils/ai/tools/registry'
import type { AiSession } from '../../../server/utils/ai/aiClient'
import { parseSections } from '../../../server/utils/ai/tools/sections/parse'
import { generateLargeDocument } from '../../fixtures/largeDocument/generate'

// The structural edit tools through the registry, as the loop and MCP call
// them: replace_section, insert_markdown, move_section, delete_section,
// set_heading, replace_all, edit_lines.

function makeSession(initial: string): { session: AiSession, ydoc: Y.Doc, ytext: Y.Text } {
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
  return { session, ydoc, ytext }
}

/** Validate like the loop does (defaults, refinements), then run. */
async function run(session: AiSession, name: string, args: Record<string, unknown>) {
  const parsed = toolSchema(name)!.safeParse(args)
  if (!parsed.success) throw new Error(`invalid args for ${name}: ${parsed.error.message}`)
  return executeFunctionByName(session, name, parsed.data)
}

function countTransactions(ydoc: Y.Doc): { count: () => number, origins: unknown[] } {
  const origins: unknown[] = []
  ydoc.on('afterTransaction', (tr: Y.Transaction) => {
    if (tr.changed.size > 0) origins.push(tr.origin)
  })
  return { count: () => origins.length, origins }
}

function addComment(ydoc: Y.Doc, ytext: Y.Text, from: number, to: number, id: string): void {
  const map = new Y.Map<unknown>()
  ydoc.getArray<Y.Map<unknown>>('comments').push([map])
  map.set('id', id)
  map.set('anchorStart', Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, from, 0))).toString('base64'))
  map.set('anchorEnd', Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, to, -1))).toString('base64'))
}

function commentText(ydoc: Y.Doc, ytext: Y.Text, id: string): string | null {
  const map = ydoc.getArray<Y.Map<unknown>>('comments').toArray().find(m => m.get('id') === id)!
  const dec = (k: string) => Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(new Uint8Array(Buffer.from(map.get(k) as string, 'base64'))), ydoc)?.index
  const s = dec('anchorStart')
  const e = dec('anchorEnd')
  return s === undefined || e === undefined || s >= e ? null : ytext.toString().slice(s, e)
}

const SMALL = [
  'Intro text.',
  '',
  '# 1 Alpha',
  '',
  'Alpha body with a comment target here.',
  '',
  '## 1.1 Alpha sub',
  '',
  'Sub body.',
  '',
  '# 2 Beta',
  '',
  'Beta body.',
  '',
  '# 3 Gamma',
  '',
  'Gamma body.',
  ''
].join('\n')

describe('replace_section', () => {
  it('replaces the body under the heading as one minimal change and keeps comments on unchanged words', async () => {
    const { session, ydoc, ytext } = makeSession(SMALL)
    const at = SMALL.indexOf('comment target')
    addComment(ydoc, ytext, at, at + 'comment target'.length, 'c1')
    const tx = countTransactions(ydoc)
    const res = await run(session, 'replace_section', { section: '1', markdown: 'Alpha body with a comment target there.\n\n## 1.1 Alpha sub\n\nSub body, longer now.' })
    expect(res.isError).toBe(false)
    expect(tx.count()).toBe(1)
    expect(tx.origins[0]).toBe('ai:assistant:s1')
    expect(ytext.toString()).toContain('# 1 Alpha\n\nAlpha body with a comment target there.\n\n## 1.1 Alpha sub\n\nSub body, longer now.\n\n# 2 Beta')
    expect(commentText(ydoc, ytext, 'c1')).toBe('comment target')
    expect(res.content).toMatch(/now spans lines 3-\d+ \(rev [0-9a-f]{6}\)/)
  })

  it('refuses a stale expected_rev with the section head', async () => {
    const { session, ytext } = makeSession(SMALL)
    const res = await run(session, 'replace_section', { section: '2', markdown: 'x', expected_rev: 'abcdef' })
    expect(res.isError).toBe(true)
    expect(res.content).toMatch(/changed since rev abcdef \(now rev [0-9a-f]{6}/)
    expect(res.content).toContain('11: # 2 Beta')
    expect(ytext.toString()).toBe(SMALL)
  })

  it('keep_heading false replaces the heading too', async () => {
    const { session, ytext } = makeSession(SMALL)
    const res = await run(session, 'replace_section', { section: 'Beta', markdown: '# 2 Bravo\n\nNew.', keep_heading: false })
    expect(res.isError).toBe(false)
    expect(ytext.toString()).toContain('# 2 Bravo\n\nNew.\n\n# 3 Gamma')
  })
})

describe('insert_markdown', () => {
  it('inserts at start, end, before and after with block spacing', async () => {
    const { session, ytext } = makeSession(SMALL)
    await run(session, 'insert_markdown', { section: '2', position: 'start', markdown: 'First.' })
    expect(ytext.toString()).toContain('# 2 Beta\n\nFirst.\n\nBeta body.')
    await run(session, 'insert_markdown', { section: '1', position: 'end', markdown: 'Last of one.' })
    expect(ytext.toString()).toContain('Sub body.\n\nLast of one.\n\n# 2 Beta')
    await run(session, 'insert_markdown', { section: '3', position: 'before', markdown: '# 2b Between' })
    expect(ytext.toString()).toContain('Beta body.\n\n# 2b Between\n\n# 3 Gamma')
    await run(session, 'insert_markdown', { position: 'end', markdown: 'The end.' })
    expect(ytext.toString().endsWith('Gamma body.\n\nThe end.\n')).toBe(true)
    const bad = await run(session, 'insert_markdown', { position: 'after', markdown: 'x' })
    expect(bad.isError).toBe(true)
  })
})

describe('move_section', () => {
  it('moves a section with its subsections in one transaction; comments and ids follow', async () => {
    const { session, ydoc, ytext } = makeSession(SMALL)
    const outline = await run(session, 'outline', {})
    const alphaId = /^(s-\d+) {2}1 /m.exec(outline.content)![1]!
    const at = SMALL.indexOf('comment target')
    addComment(ydoc, ytext, at, at + 'comment target'.length, 'c1')
    const tx = countTransactions(ydoc)
    const res = await run(session, 'move_section', { section: alphaId, after: '3' })
    expect(res.isError).toBe(false)
    expect(tx.count()).toBe(1)
    expect(ytext.toString()).toBe('Intro text.\n\n# 2 Beta\n\nBeta body.\n\n# 3 Gamma\n\nGamma body.\n\n# 1 Alpha\n\nAlpha body with a comment target here.\n\n## 1.1 Alpha sub\n\nSub body.\n')
    expect(commentText(ydoc, ytext, 'c1')).toBe('comment target')
    expect(res.content).toContain('1 comment thread moved with it')
    const read = await run(session, 'read_section', { section: alphaId })
    expect(read.content).toContain('# 1 Alpha')
  })

  it('moves before a section and to the end; refuses moves into itself and no-ops', async () => {
    const { session, ytext } = makeSession(SMALL)
    expect((await run(session, 'move_section', { section: '3', before: '1' })).isError).toBe(false)
    expect(ytext.toString().indexOf('# 3 Gamma')).toBeLessThan(ytext.toString().indexOf('# 1 Alpha'))
    expect((await run(session, 'move_section', { section: '1', to_end: true })).isError).toBe(false)
    expect(ytext.toString().trimEnd().endsWith('Sub body.')).toBe(true)
    expect((await run(session, 'move_section', { section: '1', before: '1.1' })).content).toContain('inside section')
    expect((await run(session, 'move_section', { section: '1', to_end: true })).content).toMatch(/^Error: No change/)
    expect((await run(session, 'move_section', { section: '1', before: '2', to_end: true })).isError).toBe(true)
  })

  it('swaps two chapters of the large document, keeping every other line', async () => {
    const large = generateLargeDocument()
    const { session, ytext } = makeSession(large)
    await run(session, 'move_section', { section: '5', before: '4' })
    const after = ytext.toString()
    const s = parseSections(after).sections.filter(x => x.level === 1).map(x => x.title.split(' ')[0])
    expect(s.slice(0, 6)).toEqual(['1', '2', '3', '5', '4', '6'])
    expect(after.split('\n').sort()).toEqual(large.split('\n').sort())
  })
})

describe('delete_section', () => {
  it('deletes a section with its subsections, and the last one without leftover blank lines', async () => {
    const { session, ytext } = makeSession(SMALL)
    expect((await run(session, 'delete_section', { section: '1' })).isError).toBe(false)
    expect(ytext.toString()).toBe('Intro text.\n\n# 2 Beta\n\nBeta body.\n\n# 3 Gamma\n\nGamma body.\n')
    await run(session, 'delete_section', { section: 'Gamma' })
    expect(ytext.toString()).toBe('Intro text.\n\n# 2 Beta\n\nBeta body.\n')
  })
})

describe('set_heading', () => {
  it('changes the level and pins the old anchor when the text changes', async () => {
    const { session, ytext } = makeSession('# Overview\n\ntext\n\n## Old name {.unnumbered}\n\nmore\n\n## Kept {#kept}\n')
    await run(session, 'set_heading', { section: 'Overview', level: 2 })
    expect(ytext.toString().startsWith('## Overview\n')).toBe(true)
    const res = await run(session, 'set_heading', { section: 'Old name', title: 'New name' })
    expect(res.content).toContain('{#old-name}')
    expect(ytext.toString()).toContain('## New name {#old-name .unnumbered}')
    await run(session, 'set_heading', { section: 'Kept', title: 'Still kept' })
    expect(ytext.toString()).toContain('## Still kept {#kept}')
  })
})

describe('edit_lines', () => {
  it('applies a batch bottom-up against one rev, refuses a stale rev or a wrong first line', async () => {
    const { session, ytext } = makeSession('a\nb\nc\nd\ne\n')
    const rev = parseSections(ytext.toString()).rev
    const res = await run(session, 'edit_lines', {
      base_rev: rev,
      edits: [
        { start_line: 4, end_line: 4, expected_first_line: 'd', new_text: 'D1\nD2' },
        { start_line: 1, end_line: 2, expected_first_line: 'a', new_text: 'AB' },
        { start_line: 5, end_line: 5, expected_first_line: 'e', new_text: '' }
      ]
    })
    expect(res.isError).toBe(false)
    expect(ytext.toString()).toBe('AB\nc\nD1\nD2\n')
    expect((await run(session, 'edit_lines', { base_rev: rev, edits: [{ start_line: 1, end_line: 1, expected_first_line: 'AB', new_text: 'x' }] })).content).toContain('changed since rev')
    const now = parseSections(ytext.toString()).rev
    const wrong = await run(session, 'edit_lines', { base_rev: now, edits: [{ start_line: 1, end_line: 1, expected_first_line: 'nope', new_text: 'x' }] })
    expect(wrong.content).toContain('line 1 reads "AB"')
    expect(ytext.toString()).toBe('AB\nc\nD1\nD2\n')
  })
})

const PRODUCT_DOC = [
  '# MyProduct overview',
  '',
  'MyProduct is fast. myproduct in lower case, MYPRODUCT shouting, Myproduct capitalised.',
  'MyProduct\'s docs and MyProducts plural.',
  '',
  'See [MyProduct](https://example.com/MyProduct) and https://myproduct.example.org.',
  '',
  '```js',
  'const MyProduct = 1',
  '```',
  '',
  'Inline `MyProduct` code and $MyProduct$ math.',
  '',
  '## Install MyProduct {#install}',
  ''
].join('\n')

describe('replace_all', () => {
  it('previews counts, skipped classes and match ids without changing the document', async () => {
    const { session, ytext } = makeSession(PRODUCT_DOC)
    const res = await run(session, 'replace_all', { query: 'MyProduct', replacement: 'MySuperCoolProduct', wholeWord: true })
    expect(res.isError).toBe(false)
    expect(ytext.toString()).toBe(PRODUCT_DOC)
    expect(res.content).toMatch(/^Preview, nothing changed yet\. 8 matches for "MyProduct"/)
    expect(res.content).toContain('Not touched: 1 in link targets, 1 in URLs, 1 in code blocks, 1 in inline code, 1 in math')
    expect(res.content).toMatch(/^m1@[0-9a-f]{8} {2}line 1 /m)
    expect(res.content).toContain('{#myproduct-overview}')
  })

  it('applies in one transaction with case preserved, possessives matched, headings pinned, code untouched', async () => {
    const { session, ydoc, ytext } = makeSession(PRODUCT_DOC)
    const tx = countTransactions(ydoc)
    const res = await run(session, 'replace_all', { query: 'MyProduct', replacement: 'MySuperCoolProduct', wholeWord: true, preview: false })
    expect(res.isError).toBe(false)
    expect(tx.count()).toBe(1)
    expect((res as { activity?: unknown }).activity).toEqual({ kind: 'ai.tool', tool: 'replace_all', query: 'MyProduct', replacement: 'MySuperCoolProduct', count: 8 })
    const text = ytext.toString()
    expect(text).toContain('# MySuperCoolProduct overview {#myproduct-overview}')
    expect(text).toContain('MySuperCoolProduct is fast. mysupercoolproduct in lower case, MYSUPERCOOLPRODUCT shouting, MySuperCoolProduct capitalised.')
    expect(text).toContain('MySuperCoolProduct\'s docs and MyProducts plural.')
    expect(text).toContain('See [MySuperCoolProduct](https://example.com/MyProduct) and https://myproduct.example.org.')
    expect(text).toContain('const MyProduct = 1')
    expect(text).toContain('Inline `MyProduct` code and $MyProduct$ math.')
    expect(text).toContain('## Install MySuperCoolProduct {#install}')
  })

  it('regex with capture groups catches plurals; as_given keeps the replacement exactly', async () => {
    const { session, ytext } = makeSession(PRODUCT_DOC)
    const res = await run(session, 'replace_all', { query: 'MyProduct(s?)\\b', regex: true, replacement: 'Widget$1', case: 'as_given', preview: false, scope: '1' })
    expect(res.isError).toBe(false)
    expect(ytext.toString()).toContain('Widget\'s docs and Widgets plural.')
    expect(ytext.toString()).toContain('Widget is fast. Widget in lower case, Widget shouting')
  })

  it('the documented possessive/plural lookahead pattern matches', async () => {
    const { session, ytext } = makeSession('MyProduct, MyProduct\'s and MyProducts but not MyProductive.')
    await run(session, 'replace_all', { query: 'MyProduct(?=\'s|s\\b|\\b)', regex: true, caseSensitive: true, replacement: 'Neo', preview: false })
    expect(ytext.toString()).toBe('Neo, Neo\'s and Neos but not MyProductive.')
  })

  it('applies only the chosen match ids and refuses ids from an older rev', async () => {
    const { session, ytext } = makeSession('cat cat cat\n')
    const preview = await run(session, 'replace_all', { query: 'cat', replacement: 'dog' })
    const ids = [...preview.content.matchAll(/^(m\d+@[0-9a-f]{8})/gm)].map(m => m[1]!)
    expect(ids).toHaveLength(3)
    const res = await run(session, 'replace_all', { query: 'cat', replacement: 'dog', preview: false, matchIds: [ids[0]!, ids[2]!] })
    expect(res.isError).toBe(false)
    expect(ytext.toString()).toBe('dog cat dog\n')
    const stale = await run(session, 'replace_all', { query: 'cat', replacement: 'dog', preview: false, matchIds: [ids[1]!] })
    expect(stale.isError).toBe(true)
    expect(stale.content).toContain('the document changed since')
    expect(ytext.toString()).toBe('dog cat dog\n')
  })

  it('can include code and link targets when asked, and reports no match plainly', async () => {
    const { session, ytext } = makeSession(PRODUCT_DOC)
    await run(session, 'replace_all', { query: 'MyProduct', replacement: 'X', case: 'as_given', caseSensitive: true, excludeCode: false, excludeLinkTargets: false, preview: false })
    expect(ytext.toString()).toContain('const X = 1')
    expect(ytext.toString()).toContain('(https://example.com/X)')
    const none = await run(session, 'replace_all', { query: 'zzz', replacement: 'y' })
    expect(none.content).toMatch(/^No match for "zzz"/)
  })

  it('renames a system name across the large fixture: count, code blocks and anchor ids untouched', async () => {
    const large = generateLargeDocument()
    const { session, ytext } = makeSession(large)
    const preview = await run(session, 'replace_all', { query: 'Lumen', replacement: 'Lumina', wholeWord: true })
    const total = Number(/(\d+) matches for "Lumen"/.exec(preview.content)![1])
    expect(total).toBeGreaterThan(100)
    expect(preview.content).toMatch(/Not touched: .*in code blocks/)
    const res = await run(session, 'replace_all', { query: 'Lumen', replacement: 'Lumina', wholeWord: true, preview: false })
    expect(res.content).toContain(`Replaced ${total} occurrences`)
    const after = ytext.toString()
    expect(after).toContain('{#lumen}')
    expect(after).toContain('lumen status --zone rz1 --nur-alarme')
    expect(after).toContain('FROM lumen_messwerte')
    const prose = after.split('\n').filter(l => !l.startsWith('    ') && !l.includes('`'))
    expect(prose.join('\n')).not.toMatch(/\bLumen\b(?!\})/)
  })
})
