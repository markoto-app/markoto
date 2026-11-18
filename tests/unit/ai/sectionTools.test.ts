import { describe, it, expect, vi } from 'vitest'
import * as Y from 'yjs'
import { executeFunctionByName } from '../../../server/utils/ai/tools/registry'
import type { AiSession } from '../../../server/utils/ai/aiClient'
import { TOOL_RESULT_CHAR_CAP } from '../../../server/utils/agentic/limits'
import { describeToolInput } from '../../../server/utils/agentic/streamStatus'
import { generateLargeDocument } from '../../fixtures/largeDocument/generate'

// The section reading tools through the registry, as the loop and MCP call
// them: outline, read_section and search_document.

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

const large = generateLargeDocument()
const largeLines = large.split('\n')

async function run(session: AiSession, name: string, args: Record<string, unknown>): Promise<{ content: string, isError: boolean }> {
  return executeFunctionByName(session, name, args)
}

describe('outline', () => {
  it('lists the large document with totals, ids, numbers, ranges, sizes and the delegate hint', async () => {
    const { session } = makeSession(large)
    const res = await run(session, 'outline', {})
    expect(res.isError).toBe(false)
    expect(res.content.length).toBeLessThanOrEqual(TOOL_RESULT_CHAR_CAP)
    expect(res.content).toMatch(/^Document: 3,457 lines, [\d,]+ words, about [\d,]+ tokens, \d+ headings \(rev [0-9a-f]{8}\)\./)
    expect(res.content).toMatch(/^delegate_hint: This document is large \([\d,]+ tokens\)\. For document-wide rule-like rewrites \(translate, tone, terminology\) use delegate_rewrite; for an exact pattern use search_document \+ replace_all\.$/m)
    expect(res.content).toMatch(/^s-0 {2}- {2}\(preamble\) {2}\[1-10\] {2}\d+ words {2}[0-9a-f]{6}$/m)
    expect(res.content).toMatch(/^s-\d+ {2}4\.2 {2}## Stromversorgung und Kühlung \{#strom-kuehlung\} {2}\[813-\d+\] {2}\d+ words {2}[0-9a-f]{6}$/m)
    expect(res.content).toMatch(/^s-\d+ {2}4\.2\.1 {2}### Kontrollen {2}\[826-\d+\]/m)
  })

  it('drops deeper levels when the outline does not fit, and says so', async () => {
    const doc = Array.from({ length: 60 }, (_, i) => [`# Chapter ${i}`, ...Array.from({ length: 10 }, (_, j) => `## Section ${i}.${j} with a fairly long heading title`), ''].join('\n')).join('\n')
    const { session } = makeSession(doc)
    const res = await run(session, 'outline', { depth: 6 })
    expect(res.content.length).toBeLessThanOrEqual(TOOL_RESULT_CHAR_CAP)
    expect(res.content).toContain('600 deeper headings not listed')
    expect(res.content).not.toMatch(/^s-\d+ {2}\S+ {2}## /m)
  })

  it('warns about a second H1 only when there is one', async () => {
    const one = await run(makeSession('# Title\n\n## A\n\n## B\n').session, 'outline', {})
    expect(one.content).not.toContain('Warnings')
    const two = await run(makeSession('# Title\n\n## A\n\n# Fahrzeuge\n\n## B\n').session, 'outline', {})
    expect(two.content).toContain('Warnings: more than one H1 (s-1, s-3): the document title is the only H1')
  })

  it('lists one subtree with under, and warns about level jumps', async () => {
    const { session } = makeSession('# A\n### Jump\n## B\ntext\n# C\n')
    const all = await run(session, 'outline', {})
    expect(all.content).toContain('Warnings: more than one H1 (s-1, s-4): the document title is the only H1')
    expect(all.content).toContain('; level jump: # to ### at line 2 (s-2)')
    expect(all.content).not.toContain('delegate_hint')
    const sub = await run(session, 'outline', { under: 'C' })
    expect(sub.content).toContain('Under s-4 "2 C":')
    expect(sub.content).not.toMatch(/^s-1 /m)
    expect(sub.content).not.toContain('Warnings')
  })

  it('a document without headings points to view_document', async () => {
    const { session } = makeSession('just text\nmore')
    expect((await run(session, 'outline', {})).content).toContain('It has no headings; read it with view_document.')
  })

  it('ids stay the same across calls and edits above the section', async () => {
    const { session, ytext } = makeSession(large)
    const first = await run(session, 'outline', { depth: 1 })
    const id = /^(s-\d+) {2}13 {2}/m.exec(first.content)![1]!
    ytext.insert(0, 'A new first line.\n\n')
    const second = await run(session, 'outline', { depth: 1 })
    expect(second.content).toMatch(new RegExp(`^${id} {2}13 {2}# Qualität`, 'm'))
    const read = await run(session, 'read_section', { section: id, max_chars: 1_000 })
    expect(read.content).toContain(`Section ${id} "13 Qualität`)
  })
})

describe('read_section', () => {
  it('returns the numbered section with a header, then continues where the hint says', async () => {
    const { session } = makeSession(large)
    const res = await run(session, 'read_section', { section: '9.2', max_chars: 4_000 })
    expect(res.isError).toBe(false)
    const head = /^Section (s-\d+) "9\.2 Alarmierung" \(lines 2232-(\d+), rev [0-9a-f]{6}, [\d,]+ words; 4 subsections included; doc rev [0-9a-f]{8}\)\n2232: ## 9\.2 Alarmierung/.exec(res.content)
    expect(head).not.toBeNull()
    const cont = /\[Shown: lines 2232-(\d+) of 2232-\d+ \(result size limit\)\. Continue with read_section section "(s-\d+)" and offset_line (\d+)\.\]$/.exec(res.content)
    expect(cont).not.toBeNull()
    expect(cont![2]).toBe(head![1])
    expect(Number(cont![3])).toBe(Number(cont![1]) + 1)
    const next = await run(session, 'read_section', { section: cont![2]!, offset_line: Number(cont![3]), max_chars: 4_000 })
    expect(next.content).toContain(`\n${cont![3]}: ${largeLines[Number(cont![3]) - 1]}`)
  })

  it('without subsections stops before the first one and names them', async () => {
    const { session } = makeSession(large)
    const res = await run(session, 'read_section', { section: '9.2', include_subsections: false })
    expect(res.content).toMatch(/\(lines 2232-2252, rev [0-9a-f]{6}, [\d,]+ words; subsections not included: s-\d+, s-\d+, s-\d+, s-\d+; doc rev [0-9a-f]{8}\)/)
    expect(res.content).not.toContain('2253: ')
  })

  it('refuses an offset outside the section and an unknown reference', async () => {
    const { session } = makeSession(large)
    expect((await run(session, 'read_section', { section: '9.2', offset_line: 5 })).content).toMatch(/offset_line 5 is outside section s-\d+ \(lines 2232-/)
    expect((await run(session, 'read_section', { section: 's-9999' })).content).toContain('section id s-9999 is unknown')
    expect((await run(session, 'read_section', { section: 'Schulung und Einarbeitung' })).isError).toBe(true)
  })
})

describe('search_document', () => {
  it('finds the 40 customer word forms in the large fixture, with sections and marked snippets', async () => {
    const { session } = makeSession(large)
    const res = await run(session, 'search_document', { query: String.raw`Kund(e|en|in|innen)\b`, regex: true, caseSensitive: true, limit: 200 })
    expect(res.isError).toBe(false)
    expect(res.content).toMatch(/^40 matches for "Kund\(e\|en\|in\|innen\)\\b" \(regex, case-sensitive\) in the whole document; doc rev [0-9a-f]{8}\./)
    const rows = res.content.split('\n').filter(l => /^m\d+ {2}/.test(l))
    expect(rows).toHaveLength(40)
    expect(rows[0]).toMatch(/^m1 {2}line 19 {2}s-\d+ 1 Einleitung > 1\.1 Zweck dieses Handbuchs {2}….*«Kundin».*… {2}groups: "in"$/)
    expect(res.content).not.toContain('More:')
  })

  it('whole word and case options', async () => {
    const { session } = makeSession('Kunde, kunde, Kunden, Sekunde\n')
    const plain = await run(session, 'search_document', { query: 'kunde' })
    expect(plain.content).toMatch(/^4 matches/)
    const word = await run(session, 'search_document', { query: 'kunde', wholeWord: true })
    expect(word.content).toMatch(/^2 matches/)
    const exact = await run(session, 'search_document', { query: 'kunde', wholeWord: true, caseSensitive: true })
    expect(exact.content).toMatch(/^1 match for "kunde" \(whole word, case-sensitive\)/)
    const none = await run(session, 'search_document', { query: 'Klient', wholeWord: true })
    expect(none.content).toMatch(/^0 matches .* Try without wholeWord/)
  })

  it('skips code, math and URLs by default, counts them, and includes them on request', async () => {
    const doc = [
      '# Setup',
      'The tool foo runs `foo --x`, see [foo docs](https://foo.example/foo) and $foo$.',
      '```',
      'foo bar',
      '```',
      '## Next {#foo}'
    ].join('\n')
    const { session } = makeSession(doc)
    const res = await run(session, 'search_document', { query: 'foo' })
    expect(res.content).toMatch(/^2 matches .* Not counted: 1 in inline code, 2 in link targets, 1 in math, 1 in code blocks, 1 in attribute blocks \(\{#id\}\)\./)
    const all = await run(session, 'search_document', { query: 'foo', excludeCode: false, excludeUrls: false })
    expect(all.content).toMatch(/^8 matches/)
    expect(all.content).not.toContain('Not counted')
  })

  it('limits the search to a scope section', async () => {
    const { session } = makeSession(large)
    const all = await run(session, 'search_document', { query: 'Kunde', wholeWord: true, caseSensitive: true, limit: 200 })
    const scoped = await run(session, 'search_document', { query: 'Kunde', wholeWord: true, caseSensitive: true, scope: '3' })
    const total = Number(/^(\d+) match/.exec(all.content)![1])
    const inScope = Number(/^(\d+) match/.exec(scoped.content)![1])
    expect(inScope).toBeGreaterThan(0)
    expect(inScope).toBeLessThan(total)
    expect(scoped.content).toMatch(/in section s-\d+ "3 Netzbetrieb" \(lines 445-758\)/)
    for (const line of scoped.content.split('\n').filter(l => /^m\d+/.test(l))) {
      const n = Number(/line (\d+)/.exec(line)![1])
      expect(n).toBeGreaterThanOrEqual(445)
      expect(n).toBeLessThanOrEqual(758)
    }
  })

  it('pages with a cursor and notes a changed document', async () => {
    const { session, ytext } = makeSession(Array.from({ length: 50 }, (_, i) => `row ${i} needle`).join('\n'))
    const first = await run(session, 'search_document', { query: 'needle', limit: 20 })
    const cursor = /cursor "(\d+:[0-9a-f]{8})"/.exec(first.content)![1]!
    expect(cursor.startsWith('20:')).toBe(true)
    const second = await run(session, 'search_document', { query: 'needle', limit: 20, cursor })
    expect(second.content).toContain('Matches m21-m40:')
    expect(second.content).toMatch(/^m21 {2}line 21 /m)
    ytext.insert(0, 'top needle\n')
    const changed = await run(session, 'search_document', { query: 'needle', limit: 20, cursor })
    expect(changed.content).toContain('The document changed since the previous page')
  })

  it('returns a guard error for a catastrophic pattern', async () => {
    const { session } = makeSession('aaaa')
    const res = await run(session, 'search_document', { query: '(a+)+$', regex: true })
    expect(res.isError).toBe(true)
    expect(res.content).toContain('this regular expression is not allowed')
  })

  it('stays within the result budget for many matches', async () => {
    const { session } = makeSession(large)
    const res = await run(session, 'search_document', { query: 'die', limit: 200 })
    expect(res.content.length).toBeLessThanOrEqual(TOOL_RESULT_CHAR_CAP)
    expect(res.content).toMatch(/More: call search_document with the same arguments and cursor "\d+:[0-9a-f]{8}"\./)
  })
})

describe('status lines', () => {
  it('describes the section tools as reading the document', () => {
    for (const name of ['outline', 'read_section', 'search_document']) {
      expect(describeToolInput(name, {})?.text).toBe('Reading the document…')
    }
  })
})
