import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { parseSections, parseSectionsCached, sectionAtLine, lineAtOffset, shortHash, splitHeadingText } from '../../../server/utils/ai/tools/sections/parse'
import { classifyMarkdown, overlappingRange, type MaskClass } from '../../../server/utils/ai/tools/sections/markdownMask'
import { resolveSection, sectionView } from '../../../server/utils/ai/tools/sections/sectionIds'
import { buildSearchRegExp, regexSafetyProblem, searchLines } from '../../../server/utils/ai/tools/sections/search'
import { generateLargeDocument } from '../../fixtures/largeDocument/generate'

// The section model under the reading tools: the Markdown section parser,
// the non-prose masks, stable section ids on Y.RelativePositions, and the
// guarded search.

function docWith(text: string): { ydoc: Y.Doc, ytext: Y.Text } {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('content')
  ytext.insert(0, text)
  return { ydoc, ytext }
}

const SAMPLE = [
  'Intro text before any heading.', // 1
  '', // 2
  '# Methods {#methods .wide}', // 3
  'Body of methods.', // 4
  '```bash', // 5
  '# not a heading', // 6
  '```', // 7
  '## Sampling', // 8
  'Sampling text.', // 9
  '$$', // 10
  '# not math heading', // 11
  '$$', // 12
  '<!--', // 13
  '# not a comment heading', // 14
  '-->', // 15
  '### Deep ###', // 16
  'deep text', // 17
  '', // 18
  'Setext Title', // 19
  '============', // 20
  'after setext', // 21
  '#### Jumped', // 22
  'end' // 23
].join('\n')

describe('parseSections', () => {
  const s = parseSections(SAMPLE)

  it('finds headings outside code, math and comments, with a preamble', () => {
    expect(s.sections.map(x => [x.level, x.title, x.startLine])).toEqual([
      [0, '', 1],
      [1, 'Methods', 3],
      [2, 'Sampling', 8],
      [3, 'Deep', 16],
      [1, 'Setext Title', 19],
      [4, 'Jumped', 22]
    ])
  })

  it('computes subtree ends, own-body ends and offsets', () => {
    const methods = s.sections[1]!
    expect([methods.startLine, methods.bodyEndLine, methods.endLine]).toEqual([3, 7, 18])
    expect(SAMPLE.slice(methods.startOffset, methods.endOffset)).toBe(s.lines.slice(2, 18).join('\n') + '\n')
    const setext = s.sections[4]!
    expect([setext.headingLines, setext.endLine]).toEqual([2, 23])
    expect(setext.endOffset).toBe(SAMPLE.length)
    expect(s.sections[0]!.endLine).toBe(2)
  })

  it('keeps the explicit id, strips the attribute block and closing hashes', () => {
    expect(s.sections[1]!.explicitId).toBe('methods')
    expect(splitHeadingText('Title {#x}')).toEqual({ title: 'Title', explicitId: 'x' })
    expect(splitHeadingText('Price {in CHF}')).toEqual({ title: 'Price {in CHF}', explicitId: null })
  })

  it('counts numbers like a table of contents and builds heading paths', () => {
    expect(s.sections.slice(1).map(x => x.number)).toEqual(['1', '1.1', '1.1.1', '2', '2.1'])
    expect(s.sections[3]!.headingPath).toBe('Methods > Sampling > Deep')
    expect(s.sections.every(x => !x.numberIsLiteral)).toBe(true)
  })

  it('warns about level jumps', () => {
    expect(s.warnings).toEqual(['level jump: # to #### at line 22'])
  })

  it('prefers the literal numbers of a numbered document', () => {
    const doc = '# 1 Intro\n## 1.1 Goal\n## Unnumbered\n# 3. Later\n### 3.2.1 Deep'
    const p = parseSections(doc)
    expect(p.sections.map(x => [x.number, x.numberIsLiteral, x.bareTitle])).toEqual([
      ['1', true, 'Intro'],
      ['1.1', true, 'Goal'],
      ['1.2', false, 'Unnumbered'],
      ['3', true, 'Later'],
      ['3.2.1', true, 'Deep']
    ])
  })

  it('counts words, tokens and gives a rev that follows the text', () => {
    const a = parseSections('# A\none two three\n# B\nfour')
    expect(a.sections[0]!.words).toBe(5)
    expect(a.sections[0]!.tokens).toBe(Math.round(a.sections[0]!.chars / 3.6))
    const b = parseSections('# A\none two thre3\n# B\nfour')
    expect(b.sections[0]!.rev).not.toBe(a.sections[0]!.rev)
    expect(b.sections[1]!.rev).toBe(a.sections[1]!.rev)
    expect(shortHash('x')).toMatch(/^[0-9a-f]{8}$/)
  })

  it('a document starting with a heading has no preamble', () => {
    expect(parseSections('# Only\ntext').sections.map(x => x.level)).toEqual([1])
    expect(parseSections('no headings\nat all').sections.map(x => x.level)).toEqual([0])
  })

  it('front matter and lists with dashes are not setext headings', () => {
    const p = parseSections('---\ntitle: x\n---\n\n- item\n--\n\nPara\n---\n')
    expect(p.sections.filter(x => x.level > 0).map(x => x.title)).toEqual(['Para'])
  })

  it('finds the section of a line and the line of an offset', () => {
    expect(sectionAtLine(s, 9)!.title).toBe('Sampling')
    expect(sectionAtLine(s, 1)!.level).toBe(0)
    expect(lineAtOffset(s, s.lineOffsets[7]!)).toBe(8)
  })

  it('the cached variant returns the same structure for the same text', () => {
    expect(parseSectionsCached(SAMPLE)).toBe(parseSectionsCached(SAMPLE))
  })

  it('parses the large fixture: 14 chapters, numbered, code-block # lines skipped', () => {
    const doc = generateLargeDocument()
    const p = parseSections(doc)
    expect(p.sections[0]!.level).toBe(0)
    expect(p.sections.filter(x => x.level === 1)).toHaveLength(14)
    expect(p.sections.filter(x => x.level > 0).every(x => x.numberIsLiteral)).toBe(true)
    const net = p.sections.find(x => x.number === '3')!
    expect([net.bareTitle, net.explicitId]).toEqual(['Netzbetrieb', 'netzbetrieb'])
    expect(p.sections.some(x => x.title.startsWith('Erstbeurteilung'))).toBe(false)
  })
})

describe('classifyMarkdown', () => {
  function classesOf(text: string): Array<[string, MaskClass]> {
    return classifyMarkdown(text).map(r => [text.slice(r.start, r.end), r.cls])
  }

  it('classifies code, math, links, URLs, attributes and comments; link text stays prose', () => {
    const text = [
      'See [the guide](https://ex.org/a_(b)) and ![pic](/api/files/x.png){width=50%}.',
      'Run `npm i` and pay $5 and $10, while $x^2$ is math.',
      '<https://auto.link> or https://bare.example/path.',
      '[ref]: https://ref.example "Title"',
      '[^1]: A footnote, not a reference.',
      '## Heading {#anchor}',
      '<!-- note -->',
      '```',
      'code',
      '```'
    ].join('\n')
    expect(classesOf(text)).toEqual([
      ['https://ex.org/a_(b)', 'link_target'],
      ['/api/files/x.png', 'link_target'],
      ['{width=50%}', 'attribute'],
      ['`npm i`', 'inline_code'],
      ['$x^2$', 'math'],
      ['<https://auto.link>', 'url'],
      ['https://bare.example/path', 'url'],
      ['https://ref.example "Title"', 'url'],
      ['{#anchor}', 'attribute'],
      ['<!-- note -->', 'html_comment'],
      ['```\ncode\n```', 'code_block']
    ])
  })

  it('handles multi-line comments and math blocks', () => {
    const text = 'a\n<!-- start\n# hidden\nend -->\nb\n$$\nx\n$$\nc'
    expect(classesOf(text)).toEqual([
      ['<!-- start\n# hidden\nend -->', 'html_comment'],
      ['$$\nx\n$$', 'math']
    ])
  })

  it('finds the range overlapping a span', () => {
    const ranges = classifyMarkdown('aa `bb` cc `dd` ee')
    expect(overlappingRange(ranges, 4, 5)?.cls).toBe('inline_code')
    expect(overlappingRange(ranges, 8, 10)).toBeNull()
    expect(overlappingRange(ranges, 14, 17)?.cls).toBe('inline_code')
    expect(overlappingRange(ranges, 0, 2)).toBeNull()
  })
})

describe('section ids', () => {
  it('survive concurrent inserts from a second Y.Doc synced via updates', () => {
    const a = docWith('# One\ntext\n## Two\nmore\n# Three\nend\n')
    const before = sectionView(a)
    const idOf = (title: string, v = before): string => v.ids[v.structure.sections.findIndex(s => s.title === title)]!
    const two = idOf('Two')
    const three = idOf('Three')

    // A collaborator inserts lines above "Two" and a new heading before "Three".
    const b = new Y.Doc()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a.ydoc))
    const bt = b.getText('content')
    bt.insert(bt.toJSON().indexOf('## Two'), 'inserted line\n\n')
    bt.insert(bt.toJSON().indexOf('# Three'), '# New\nnew body\n')
    Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a.ydoc)))

    const after = sectionView(a)
    expect(idOf('Two', after)).toBe(two)
    expect(idOf('Three', after)).toBe(three)
    const fresh = idOf('New', after)
    expect(fresh).not.toBe(two)
    expect(Number(fresh.slice(2))).toBeGreaterThan(Number(three.slice(2)))
    const r = resolveSection(a, two)
    expect(r.ok && r.section.startLine).toBe(5)
  })

  it('follow a heading whose line was retyped, and drop ids of deleted headings', () => {
    const d = docWith('# Keep\na\n# Retype\nb\n# Gone\nc\n')
    const v = sectionView(d)
    const [keep, retype, gone] = v.ids
    // Replace the whole "Retype" heading line (delete + insert), delete "Gone".
    const text = d.ytext.toJSON()
    d.ydoc.transact(() => {
      const at = text.indexOf('# Retype')
      d.ytext.delete(at, '# Retype'.length)
      d.ytext.insert(at, '# Retype')
    })
    const t2 = d.ytext.toJSON()
    d.ytext.delete(t2.indexOf('# Gone'), '# Gone\nc\n'.length)
    const v2 = sectionView(d)
    expect(v2.ids).toEqual([keep, retype])
    const r = resolveSection(d, gone!)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('Call outline again')
  })

  it('are kept per Y.Doc', () => {
    const a = docWith('# A\n# B\n')
    const b = docWith('# X\n')
    expect(sectionView(a).ids).toEqual(['s-1', 's-2'])
    expect(sectionView(b).ids).toEqual(['s-1'])
    expect(sectionView(a).ids).toEqual(['s-1', 's-2'])
  })

  it('resolve by number, heading text, and report ambiguity with candidates', () => {
    const d = docWith(generateLargeDocument())
    const byNum = resolveSection(d, '4.2')
    expect(byNum.ok && byNum.section.title).toBe('4.2 Stromversorgung und Kühlung')
    const byText = resolveSection(d, 'stromversorgung und kühlung')
    expect(byText.ok && byText.id).toBe(byNum.ok && byNum.id)
    const byFull = resolveSection(d, '## 4.2 Stromversorgung und Kühlung')
    expect(byFull.ok && byFull.id).toBe(byNum.ok && byNum.id)
    const amb = resolveSection(d, 'Schulung und Einarbeitung')
    expect(amb.ok).toBe(false)
    expect(!amb.ok && amb.error).toMatch(/headings read "Schulung und Einarbeitung": s-\d+ "\d+\.\d+\.\d+ Schulung und Einarbeitung" \(line \d+\)/)
    const none = resolveSection(d, '99.9')
    expect(!none.ok && none.error).toContain('no section is numbered 99.9')
    const preamble = resolveSection(d, 's-0')
    expect(preamble.ok && preamble.section.level).toBe(0)
  })
})

describe('search guards', () => {
  it('refuses catastrophic and oversized patterns', () => {
    expect(regexSafetyProblem('(a+)+$')).toMatch(/repeated group contains another repetition/)
    expect(regexSafetyProblem('(?:x*)*')).toMatch(/another repetition/)
    expect(regexSafetyProblem('(a|aa)*')).toMatch(/alternatives/)
    expect(regexSafetyProblem('(\\w+\\s?){2,}')).toMatch(/another repetition/)
    expect(regexSafetyProblem('(a)\\1')).toMatch(/backreferences/)
    expect(regexSafetyProblem('x'.repeat(201))).toMatch(/at most 200/)
    expect(regexSafetyProblem('Kund(e|en|in|innen)\\b')).toBeNull()
    expect(regexSafetyProblem('[(+)]+ (\\d+)')).toBeNull()
    expect(regexSafetyProblem('(ab){3}')).toBeNull()
  })

  it('reports invalid and empty-matching patterns', () => {
    expect(buildSearchRegExp({ query: '(', regex: true })).toMatchObject({ ok: false, error: expect.stringContaining('invalid regular expression') })
    expect(buildSearchRegExp({ query: 'x*', regex: true })).toMatchObject({ ok: false, error: expect.stringContaining('matches empty text') })
  })

  it('stops when the time budget runs out', () => {
    const p = parseSections(Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n'))
    let t = 0
    const r = searchLines(p, [], { query: 'line' }, { timeBudgetMs: 100, now: () => (t += 40) })
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/took longer than 0.1 seconds and was stopped at line \d+/) })
  })

  it('searches very long lines in windows without losing or doubling matches', () => {
    const line = Array.from({ length: 3000 }, (_, i) => `w${i} needle`).join(' ')
    const p = parseSections(line)
    const r = searchLines(p, [], { query: 'needle' })
    expect(r.ok && r.outcome.matches.length).toBe(3000)
  })
})
