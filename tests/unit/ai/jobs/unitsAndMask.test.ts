import { describe, expect, it } from 'vitest'
import { generateLargeDocument } from '../../../fixtures/largeDocument/generate'
import { buildJobUnits, unitContext, UNIT_MAX_TOKENS, SUMMARY_UNIT_MAX_TOKENS } from '../../../../server/utils/ai/jobs/units'
import { maskText, unmaskText, countPlaceholders } from '../../../../server/utils/ai/jobs/mask'
import { parseSections } from '../../../../server/utils/ai/tools/sections/parse'

const LARGE = generateLargeDocument()

function contiguous(units: Array<{ start: number, end: number }>): boolean {
  return units.every((u, i) => i === 0 || units[i - 1]!.end === u.start)
}

describe('buildJobUnits', () => {
  it('covers the whole large document in contiguous units within the window', () => {
    const units = buildJobUnits(LARGE, 'all', { mode: 'rewrite' })
    expect(units.length).toBeGreaterThan(50)
    expect(contiguous(units)).toBe(true)
    expect(units.map(u => u.text).join('')).toBe(LARGE.slice(units[0]!.start, units.at(-1)!.end))
    expect(units.at(-1)!.end).toBe(LARGE.length)
    // Only a single paragraph larger than the window may exceed it.
    expect(units.filter(u => u.tokens > UNIT_MAX_TOKENS).length).toBe(0)
    expect(units.every((u, i) => u.ordinal === i && u.rev.length === 8)).toBe(true)
  })

  it('never cuts inside a fenced code block, math block or table', () => {
    const units = buildJobUnits(LARGE, 'all', { mode: 'rewrite', granularity: 'paragraph' })
    for (const u of units) {
      const fences = u.text.split('\n').filter(l => /^ {0,3}(?:```|~~~)/.test(l)).length
      expect(fences % 2).toBe(0)
      const mathFences = u.text.split('\n').filter(l => /^\s*\$\$\s*$/.test(l)).length
      expect(mathFences % 2).toBe(0)
      expect(u.text.trimStart().startsWith('|---')).toBe(false)
    }
  })

  it('takes small sections whole and merges small siblings', () => {
    const doc = '# A\n\nshort a.\n\n## A1\n\none.\n\n## A2\n\ntwo.\n\n# B\n\nshort b.\n'
    const units = buildJobUnits(doc, 'all', { mode: 'rewrite' })
    expect(units.map(u => u.text)).toEqual([doc])
    // Mid-size siblings are packed up to the target in the rewriting modes, not in comment mode.
    const mid = (t: string) => `# ${t}\n\n${'Satz mit Inhalt. '.repeat(140)}\n\n`
    expect(buildJobUnits(mid('A') + mid('B'), 'all', { mode: 'rewrite' }).map(u => u.headingPath)).toEqual(['A'])
    expect(buildJobUnits(mid('A') + mid('B'), 'all', { mode: 'comment' }).map(u => u.headingPath)).toEqual(['A', 'B'])
    // Siblings too large to pack stay apart.
    const big = (t: string) => `# ${t}\n\n${'Satz mit Inhalt. '.repeat(400)}\n\n`
    expect(buildJobUnits(big('A') + big('B'), 'all', { mode: 'translate' }).map(u => u.headingPath)).toEqual(['A', 'B'])
  })

  it('packs the whole large document well under the 200-unit job cap', () => {
    for (const mode of ['rewrite', 'translate', 'terminology'] as const) {
      const units = buildJobUnits(LARGE, 'all', { mode })
      expect(units.length).toBeGreaterThanOrEqual(80)
      expect(units.length).toBeLessThanOrEqual(110)
      expect(units.every(u => u.tokens <= UNIT_MAX_TOKENS)).toBe(true)
      expect(contiguous(units)).toBe(true)
    }
  })

  it('splits an oversize section at its children and an oversize run at paragraphs', () => {
    const para = (n: number) => `${'Wort '.repeat(300)}${n}.\n\n`
    const doc = `# Big\n\n${para(1)}${para(2)}## Child\n\n${para(3)}${para(4)}${para(5)}${para(6)}${para(7)}${para(8)}${para(9)}${para(10)}`
    const units = buildJobUnits(doc, 'all', { mode: 'rewrite' })
    expect(units.length).toBeGreaterThan(2)
    expect(units[0]!.headingPath).toBe('Big')
    expect(units.slice(1).every(u => u.headingPath === 'Big > Child')).toBe(true)
    expect(contiguous(units)).toBe(true)
  })

  it('targets sections and subtrees by index', () => {
    const doc = '# A\n\na\n\n# B\n\nb\n\n## B1\n\nb1\n\n# C\n\nc\n'
    const s = parseSections(doc)
    const b = s.sections.findIndex(x => x.title === 'B')
    const c = s.sections.findIndex(x => x.title === 'C')
    expect(buildJobUnits(doc, { under: b }, { mode: 'rewrite' }).map(u => u.text)).toEqual(['# B\n\nb\n\n## B1\n\nb1\n\n'])
    expect(buildJobUnits(doc, { sections: [c, b, b + 1] }, { mode: 'rewrite', granularity: 'section' }).map(u => u.headingPath)).toEqual(['B', 'B > B1', 'C'])
  })

  it('summarise uses whole chapters up to the summary window, below a lone title heading', () => {
    const units = buildJobUnits(LARGE, 'all', { mode: 'summarise' })
    expect(units.length).toBeGreaterThan(5)
    expect(units.every(u => u.tokens <= SUMMARY_UNIT_MAX_TOKENS)).toBe(true)
    const titled = buildJobUnits('# Title\n\nIntro.\n\n## One\n\nx\n\n## Two\n\ny\n', 'all', { mode: 'summarise' })
    expect(titled.map(u => u.headingPath)).toEqual(['Title', 'Title > One', 'Title > Two'])
  })

  it('only_matching yields the paragraphs that contain a match', () => {
    const units = buildJobUnits(LARGE, 'all', { mode: 'terminology', onlyMatching: /\bKund(?:e|en|in|innen)\b/ })
    expect(units.length).toBeGreaterThan(10)
    expect(units.every(u => /\bKund(?:e|en|in|innen)\b/.test(u.text))).toBe(true)
    expect(units.every(u => u.tokens < 1500)).toBe(true)
  })

  it('scan uses few large chunks', () => {
    const units = buildJobUnits(LARGE, 'all', { mode: 'scan' })
    expect(units.length).toBeLessThan(30)
    expect(contiguous(units)).toBe(true)
  })

  it('unitContext returns the neighbouring paragraphs, capped', () => {
    const text = 'one\n\ntwo two\n\nUNIT\n\nthree\n\nfour'
    const start = text.indexOf('UNIT')
    expect(unitContext(text, start, start + 4)).toEqual({ before: 'two two', after: 'three' })
    expect(unitContext(`${'x'.repeat(5000)}\n\nU`, 5002, 5003, 10).before.length).toBe(36)
  })
})

describe('maskText', () => {
  it('round-trips the large document exactly', () => {
    const m = maskText(LARGE)
    expect(m.placeholders.length).toBeGreaterThan(100)
    expect(unmaskText(m.masked, m.placeholders)).toBe(LARGE)
    expect(m.masked).not.toContain('```')
    expect(m.masked).not.toContain('/api/files/')
    expect(m.masked).not.toMatch(/\]\((?!⟦P\d+⟧\))/)
  })

  it('round-trips every unit of the large document', () => {
    for (const u of buildJobUnits(LARGE, 'all', { mode: 'translate' })) {
      const m = maskText(u.text)
      expect(unmaskText(m.masked, m.placeholders)).toBe(u.text)
      expect([...countPlaceholders(m.masked).values()].every(c => c === 1)).toBe(true)
    }
  })

  it('masks each protected construct and keeps prose and link text', () => {
    const text = [
      'See [the guide](https://example.com/a_(b)) and ![chart](/api/files/doc/f1.png).',
      'Inline `code` and $x^2$ math, a note[^n1] and <https://auto.link>.',
      'Heading id: ## Title {#keep .cls}',
      '<!-- comment --> <span class="x">raw</span>',
      '',
      '```js',
      'const a = 1',
      '```',
      '',
      '$$',
      'E = mc^2',
      '$$',
      '',
      '[ref]: https://example.com/ref "Title"',
      '[^n1]: The footnote text.',
      'Already ⟦P1⟧ in the text.'
    ].join('\n')
    const m = maskText(text)
    expect(unmaskText(m.masked, m.placeholders)).toBe(text)
    for (const kept of ['See [the guide](', 'chart', 'Inline', 'math, a note', 'The footnote text.', 'raw']) expect(m.masked).toContain(kept)
    for (const gone of ['https://', '/api/files', '`code`', '$x^2$', '[^n1]', '{#keep', '<!--', '<span', 'const a', 'E = mc', '[ref]:']) expect(m.masked).not.toContain(gone)
    expect(m.placeholders).toContain('⟦P1⟧')
  })
})
