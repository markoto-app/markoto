import { describe, it, expect, vi } from 'vitest'
import * as Y from 'yjs'
import { executeFunctionByName, toolSchema } from '../../../server/utils/ai/tools/registry'
import type { AiSession } from '../../../server/utils/ai/aiClient'
import { parseSections } from '../../../server/utils/ai/tools/sections/parse'
import { planRenumber } from '../../../server/utils/ai/tools/sections/renumber'
import { generateLargeDocument } from '../../fixtures/largeDocument/generate'

// Regression for the staging session of 2026-11-18 on a German handbook
// (doc YacFgf1tHR): "Swap chapter 10 and chapter 12, and renumber them so
// the numbering stays in order." The swap was right; the renumbering ran
// as a chain of replace_all calls (12→10, then 10→12, ...) that collided,
// pinned 31 stale `{#h-1211-...}` ids, and a follow-up regex replacement
// ("^#{1,6} 12... " → "# 10$1$2$3 ") turned every ## / ### heading of
// three chapters into a level-1 heading. These tests drive the tools the
// way the loop does.

function makeSession(initial: string, extra: Partial<AiSession> = {}): { session: AiSession, ydoc: Y.Doc, ytext: Y.Text } {
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
    destroy: async () => {},
    ...extra
  } as unknown as AiSession
  return { session, ydoc, ytext }
}

async function run(session: AiSession, name: string, args: Record<string, unknown>) {
  const parsed = toolSchema(name)!.safeParse(args)
  if (!parsed.success) throw new Error(`invalid args for ${name}: ${parsed.error.message}`)
  return executeFunctionByName(session, name, parsed.data)
}

function transactions(ydoc: Y.Doc): () => number {
  let n = 0
  ydoc.on('afterTransaction', (tr: Y.Transaction) => {
    if (tr.changed.size > 0) n++
  })
  return () => n
}

/** Every heading as `level|title`, in document order. */
function headings(text: string): Array<{ level: number, title: string }> {
  return parseSections(text).sections.filter(s => s.level > 0).map(s => ({ level: s.level, title: s.title }))
}

/** The text with the number in front of every heading removed: what renumbering must not touch. */
function withoutHeadingNumbers(text: string): string {
  return text.replace(/^(#{1,6} )\d+(?:\.\d+)*\.? /gm, '$1')
}

/** Numbers of the numbered headings are 1, 1.1, 1.1.1 ... in document order. */
function numberingInOrder(text: string): boolean {
  const counters: number[] = []
  for (const h of parseSections(text).sections) {
    const m = /^(\d+(?:\.\d+)*) /.exec(h.title)
    if (h.level === 0 || !m) continue
    const depth = h.level - 1
    counters.length = depth + 1
    counters[depth] = (counters[depth] ?? 0) + 1
    if (m[1] !== counters.join('.')) return false
  }
  return true
}

describe('swap two chapters and renumber (large fixture)', () => {
  it('renumbers every heading in one edit: levels, titles, ids and body untouched, link texts follow', async () => {
    const original = generateLargeDocument()
    const { session, ydoc, ytext } = makeSession(original)
    const swap = await run(session, 'swap_sections', { a: '10', b: '12' })
    expect(swap.isError).toBe(false)
    expect(swap.content).toContain('renumber_headings')
    const swapped = ytext.toString()
    expect(swapped).toMatch(/^# 12 Notfall- und Krisenorganisation \{#notfall\}$/m)
    expect(numberingInOrder(swapped)).toBe(false)

    const count = transactions(ydoc)
    const res = await run(session, 'renumber_headings', {})
    expect(res.isError).toBe(false)
    expect(count()).toBe(1)
    const after = ytext.toString()

    // Numbers in order, chapters where the swap put them.
    expect(numberingInOrder(after)).toBe(true)
    expect(after).toMatch(/^# 10 Notfall- und Krisenorganisation \{#notfall\}$/m)
    expect(after).toMatch(/^## 10\.3 Notbetrieb und Wiederanlauf \{#wiederanlauf\}$/m)
    expect(after).toMatch(/^### 10\.1\.2 Risiken$/m)
    expect(after).toMatch(/^# 11 Lieferanten und Verträge \{#lieferanten\}$/m)
    expect(after).toMatch(/^# 12 Servicezeiten und Anfragen \{#service\}$/m)
    expect(after).toMatch(/^### 12\.4\.4 Risiken$/m)

    // Levels and the heading texts after the number are exactly the swapped ones.
    const levels = (t: string) => headings(t).map(h => h.level)
    expect(levels(after)).toEqual(levels(swapped))
    expect(levels(after)).toEqual(levels(original))
    // Nothing but heading numbers and the cross-reference's number changed.
    expect(withoutHeadingNumbers(after).replaceAll('[Abschnitt 10.3](#wiederanlauf)', '[Abschnitt 12.3](#wiederanlauf)')).toBe(withoutHeadingNumbers(swapped))
    // No explicit ids added (the staging run pinned 31 stale `{#h-1211-...}` ids).
    expect(after.match(/\{#/g)?.length).toBe(original.match(/\{#/g)?.length)
    expect(after).not.toMatch(/\{#h-\d/)
    // The link text names the section's new number.
    expect(after).toContain('[Abschnitt 10.3](#wiederanlauf)')
    expect(res.content).toMatch(/^Renumbered \d+ of \d+ numbered headings in one edit/)
    expect(res.content).toContain('# 12 → 10 Notfall- und Krisenorganisation')
    expect(res.content).toMatch(/\d+ link texts? got the new section number/)

    // A second call has nothing to do.
    const again = await run(session, 'renumber_headings', {})
    expect(again.isError).toBe(true)
    expect(again.content).toMatch(/already in order/)
  })

  it('preview lists the changes and changes nothing', async () => {
    const { session, ytext } = makeSession(generateLargeDocument())
    await run(session, 'swap_sections', { a: '10', b: '12' })
    const before = ytext.toString()
    const res = await run(session, 'renumber_headings', { preview: true })
    expect(res.isError).toBe(false)
    expect(res.content).toMatch(/^Preview, nothing changed yet/)
    expect(ytext.toString()).toBe(before)
  })
})

describe('replace_all keeps heading levels', () => {
  const DOC = [
    '# 10 Notfall',
    '',
    'Text.',
    '',
    '## 12.1 Notfallstufen',
    '',
    '### 12.1.1 Risiken',
    '',
    '# 12 Service',
    ''
  ].join('\n')

  it('refuses the staging replacement that turned ## and ### headings into level 1', async () => {
    const { session, ytext } = makeSession(DOC)
    // The exact call of the follow-up session XdhSkHTrjS1F.
    const res = await run(session, 'replace_all', { query: '^#{1,6} 12(\\.\\d+)?(\\.\\d+)?(\\.\\d+)? ', regex: true, replacement: '# 10$1$2$3 ', preview: false })
    expect(res.isError).toBe(true)
    expect(res.content).toMatch(/would change the level of 2 headings/)
    expect(res.content).toContain('## → #')
    expect(res.content).toContain('renumber_headings')
    expect(ytext.toString()).toBe(DOC)
  })

  it('applies a replacement that keeps the # marks', async () => {
    const { session, ytext } = makeSession(DOC)
    const res = await run(session, 'replace_all', { query: '^(#{1,6} )12(\\.\\d+)?(\\.\\d+)?', regex: true, replacement: '$110$2$3', preview: false, scope: '10' })
    expect(res.isError).toBe(false)
    expect(ytext.toString()).toContain('## 10.1 Notfallstufen')
    expect(ytext.toString()).toContain('### 10.1.1 Risiken')
    expect(headings(ytext.toString()).map(h => h.level)).toEqual([1, 2, 3, 1])
  })

  it('changes levels only with changeHeadingLevels', async () => {
    const { session, ytext } = makeSession(DOC)
    const res = await run(session, 'replace_all', { query: '^### ', regex: true, replacement: '## ', preview: false, changeHeadingLevels: true })
    expect(res.isError).toBe(false)
    expect(headings(ytext.toString()).map(h => h.level)).toEqual([1, 2, 2, 1])
  })

  it('refuses a replacement that creates or removes headings', async () => {
    const { session, ytext } = makeSession('# A\n\nText #tag here.\n')
    const res = await run(session, 'replace_all', { query: 'Text ', replacement: '# Text ', preview: false })
    expect(res.isError).toBe(true)
    expect(res.content).toMatch(/turn 1 line into headings/)
    expect(ytext.toString()).toBe('# A\n\nText #tag here.\n')
  })
})

describe('renumber plan', () => {
  it('keeps a trailing dot, setext headings and unnumbered headings; leaves a mismatched depth alone', () => {
    const text = [
      'Handbook',
      '========',
      '',
      '## 3. Start',
      '',
      '### 3.4 Sub',
      '',
      '## Appendix',
      '',
      '## 1. Next',
      '',
      '### 7 Odd depth',
      ''
    ].join('\n')
    const planned = planRenumber(parseSections(text))
    if (!planned.ok) throw new Error(planned.error)
    const { changes, mismatched, baseLevel } = planned.plan
    expect(baseLevel).toBe(2)
    // Counting starts at the lowest top-level number used (1 here), a trailing dot stays.
    expect(changes.map(c => `${c.from}→${c.to}`)).toEqual(['3→1', '3.4→1.1', '1→2'])
    expect(text.slice(changes[0]!.start, changes[0]!.end + 1)).toBe('3.')
    expect(mismatched).toEqual([{ line: 12, heading: '7 Odd depth' }])
  })

  it('has nothing to do without numbered headings', () => {
    const planned = planRenumber(parseSections('# A\n\n## B\n'))
    expect(planned.ok).toBe(false)
  })

  it('swap of chapters 1 and 2 then renumber: numbering starts at 1 again, link target and text follow', async () => {
    const { session, ytext } = makeSession('# 1 Alpha\n\nSee [Abschnitt 2.1](#h-21-beta-sub).\n\n## 1.1 Alpha sub\n\nA.\n\n# 2 Beta\n\n## 2.1 Beta sub\n\nB.\n')
    await run(session, 'swap_sections', { a: '1', b: '2' })
    const res = await run(session, 'renumber_headings', {})
    expect(res.content).toMatch(/^Renumbered 4 of 4 numbered headings in one edit/)
    const text = ytext.toString()
    expect(text.split('\n').filter(l => l.startsWith('#'))).toEqual(['# 1 Beta', '## 1.1 Beta sub', '# 2 Alpha', '## 2.1 Alpha sub'])
    expect(text).toContain('See [Abschnitt 1.1](#h-11-beta-sub).')
  })

  it('points links to automatic anchors at the renumbered heading', async () => {
    const { session, ytext } = makeSession('# 2 Alpha\n\nSee [Alpha](#h-2-alpha) and [Abschnitt 2](#h-2-alpha).\n\n# 1 Beta\n')
    const res = await run(session, 'renumber_headings', {})
    expect(res.isError).toBe(false)
    expect(ytext.toString()).toBe('# 1 Alpha\n\nSee [Alpha](#h-1-alpha) and [Abschnitt 1](#h-1-alpha).\n\n# 2 Beta\n')
  })
})

describe('replace_all word forms (German compounds)', () => {
  const DOC = [
    '## 2.4 Pikettdienst',
    '',
    'Der Pikettdienst ist geregelt. Die Dauer des Pikettdienstes ist fix.',
    'Pikettleistende und die Pikettorganisation melden sich. Pikett gilt.',
    ''
  ].join('\n')

  it('preview lists the word forms and warns about the missing linking s', async () => {
    const { session, ytext } = makeSession(DOC)
    const res = await run(session, 'replace_all', { query: 'Pikett', replacement: 'Bereitschaft' })
    expect(res.isError).toBe(false)
    expect(ytext.toString()).toBe(DOC)
    expect(res.content).toContain('Word forms: Pikettdienst (2) → Bereitschaftdienst')
    expect(res.content).toContain('Pikettdienstes (1) → Bereitschaftdienstes')
    expect(res.content).toMatch(/Check: 5 matches sit inside compound words where the replacement probably needs a linking "s"/)
  })

  it('forms replaces whole words with their own replacement and reports unlisted words', async () => {
    const { session, ytext } = makeSession(DOC)
    const res = await run(session, 'replace_all', {
      query: 'Pikett',
      replacement: 'Bereitschaft',
      preview: false,
      forms: [
        { word: 'Pikettdienst', replacement: 'Bereitschaftsdienst' },
        { word: 'Pikettdienstes', replacement: 'Bereitschaftsdienstes' },
        { word: 'Pikettorganisation', replacement: 'Bereitschaftsorganisation' },
        { word: 'Pikett', replacement: 'Bereitschaft' }
      ]
    })
    expect(res.isError).toBe(false)
    expect(res.content).toContain('Not in forms, left unchanged: Pikettleistende (1)')
    expect(ytext.toString()).toBe([
      '## 2.4 Bereitschaftsdienst',
      '',
      'Der Bereitschaftsdienst ist geregelt. Die Dauer des Bereitschaftsdienstes ist fix.',
      'Pikettleistende und die Bereitschaftsorganisation melden sich. Bereitschaft gilt.',
      ''
    ].join('\n'))
  })

  it('a large replacement waits for the user, who sees the count and the word forms', async () => {
    const doc = Array.from({ length: 12 }, (_, i) => `Zeile ${i}: Pikettdienst.`).join('\n') + '\n'
    const confirmReplace = vi.fn(async (): Promise<{ allowed: boolean, note: string | null }> => ({ allowed: false, note: 'Nur Kapitel 2' }))
    const extra: Partial<AiSession> = { confirmReplace }
    const { session, ytext } = makeSession(doc, extra)
    const res = await run(session, 'replace_all', { query: 'Pikettdienst', replacement: 'Bereitschaftsdienst', preview: false })
    expect(confirmReplace).toHaveBeenCalledWith({ total: 12, forms: [{ from: 'Pikettdienst', to: 'Bereitschaftsdienst', count: 12 }] })
    expect(res.isError).toBe(true)
    expect(res.content).toContain('"Nur Kapitel 2"')
    expect(ytext.toString()).toBe(doc)

    confirmReplace.mockResolvedValueOnce({ allowed: true, note: null })
    const ok = await run(session, 'replace_all', { query: 'Pikettdienst', replacement: 'Bereitschaftsdienst', preview: false })
    expect(ok.isError).toBe(false)
    expect(ytext.toString()).not.toContain('Pikett')
  })
})
