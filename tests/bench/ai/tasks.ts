import type { BenchTask, ScriptApi, ScriptCall, ToolOutcome } from './harness'

// The benchmark tasks, scripted the way a competent model does them with
// the current tools. Each script plays the model: it reads the document from
// the real tool results and builds old_str from them, so the edits really
// apply. Variant `step4`: the scripts start with `outline` (section ids,
// numbers, line ranges), read what they need with `read_section` (several
// sections in one turn, following the continuation hints) and find terms
// with `search_document`; edits still go through replace_text / insert_text /
// create_comment (structural edit tools come later). Keep the ids and
// prompts stable so results stay comparable with `results/baseline.*` and
// the earlier variants.

const VARIANT = 'step4'

// Reading the document through outline + read_section (what the model reads
// off the results)

interface OutlineRow { id: string, number: string, start: number, end: number, level: number, title: string, words: number }

interface DocReader {
  rows: OutlineRow[]
  /** Lines read so far, by line number. */
  known: Map<number, string>
}

const NUMBERED_LINE_RE = /^(\d+): (.*)$/
const OUTLINE_ROW_RE = /^(s-\d+) {2}(\S+) {2}(#{1,6}) (.*?) {2}\[(\d+)(?:-(\d+))?\] {2}(\d+) words {2}[0-9a-f]{6}$/
const CONTINUE_RE = /Continue with read_section section "(s-\d+)" and offset_line (\d+)\./
/** Biggest read_section result (the tool's own cap). */
const READ_MAX_CHARS = 22_000

/** First call: the outline, default depth (3 levels). */
async function openDocument(api: ScriptApi): Promise<DocReader> {
  const res = await api.call('outline', {})
  if (res.isError) throw new Error(`outline failed: ${res.output.slice(0, 200)}`)
  const reader: DocReader = { rows: [], known: new Map() }
  for (const row of res.output.split('\n')) {
    const m = OUTLINE_ROW_RE.exec(row)
    if (m) {
      reader.rows.push({ id: m[1]!, number: m[2]!, level: m[3]!.length, title: m[4]!, start: Number(m[5]), end: Number(m[6] ?? m[5]), words: Number(m[7]) })
    }
  }
  if (reader.rows.length === 0) throw new Error('outline listed no sections')
  return reader
}

/** Record the "N: text" lines of a read result; returns the continuation call if it was cut. */
function absorbRead(reader: DocReader, res: ToolOutcome | undefined): ScriptCall | null {
  if (!res || res.isError) throw new Error(`read failed: ${res?.output.slice(0, 200)}`)
  for (const row of res.output.split('\n')) {
    const m = NUMBERED_LINE_RE.exec(row)
    if (m) reader.known.set(Number(m[1]), m[2]!)
  }
  const cont = CONTINUE_RE.exec(res.output)
  return cont ? { name: 'read_section', args: { section: cont[1], offset_line: Number(cont[2]), max_chars: READ_MAX_CHARS } } : null
}

function rowByNumber(reader: DocReader, number: string): OutlineRow {
  const row = reader.rows.find(r => r.number === number)
  if (!row) throw new Error(`section ${number} not in the outline`)
  return row
}

function children(reader: DocReader, row: OutlineRow): OutlineRow[] {
  return reader.rows.filter(r => r.level === row.level + 1 && r.start > row.start && r.end <= row.end)
}

/**
 * Read sections in as few turns as possible: one turn with a read_section
 * per section (a long one as its own text plus one call per direct
 * subsection, so each fits), then turns for the continuations. `extra`
 * calls ride along in the first turn; their results are returned.
 */
async function readSections(api: ScriptApi, reader: DocReader, rows: OutlineRow[], extra: ScriptCall[] = []): Promise<ToolOutcome[]> {
  const calls: ScriptCall[] = []
  for (const row of rows) {
    const subs = children(reader, row)
    // About 7 characters per word plus line numbers: a section over the cap is read per subsection.
    if (row.words * 7 > READ_MAX_CHARS && subs.length > 0) {
      calls.push({ name: 'read_section', args: { section: row.id, include_subsections: false, max_chars: READ_MAX_CHARS } })
      for (const sub of subs) calls.push({ name: 'read_section', args: { section: sub.id, max_chars: READ_MAX_CHARS } })
    } else {
      calls.push({ name: 'read_section', args: { section: row.id, max_chars: READ_MAX_CHARS } })
    }
  }
  const results = await api.turn([...extra, ...calls])
  let next = results.slice(extra.length).flatMap(r => absorbRead(reader, r) ?? [])
  while (next.length > 0) {
    const more = await api.turn(next)
    next = more.flatMap(r => absorbRead(reader, r) ?? [])
  }
  return results.slice(0, extra.length)
}

/** Lines [start, end] as read; throws when one was not read. */
function linesOf(reader: DocReader, start: number, end: number): string[] {
  const out: string[] = []
  for (let n = start; n <= end; n++) {
    const line = reader.known.get(n)
    if (line === undefined) throw new Error(`line ${n} not read`)
    out.push(line)
  }
  return out
}

/** Last line of a section without the blank lines and page break before the next heading. */
function trimmedEnd(reader: DocReader, row: OutlineRow): number {
  let end = row.end
  while (end > row.start && (reader.known.get(end)!.trim() === '' || reader.known.get(end) === '<!-- pagebreak -->')) end -= 1
  return end
}

/** Read a section and return it as a block, like `blockAt` on the full text. */
async function readBlock(api: ScriptApi, reader: DocReader, row: OutlineRow): Promise<Block> {
  await readSections(api, reader, [row])
  return blockOf(reader, row)
}

function blockOf(reader: DocReader, row: OutlineRow): Block {
  const end = trimmedEnd(reader, row)
  return { startLine: row.start, endLine: end, text: linesOf(reader, row.start, end).join('\n'), heading: reader.known.get(row.start)!.replace(/^#+ /, '') }
}

interface Heading { line: number, level: number, text: string }

/** Headings with 1-based line numbers, skipping fenced code. */
function headings(text: string): Heading[] {
  const out: Heading[] = []
  let inFence = false
  text.split('\n').forEach((line, i) => {
    if (line.startsWith('```')) {
      inFence = !inFence
      return
    }
    const m = !inFence && /^(#{1,6}) (.*)$/.exec(line)
    if (m) out.push({ line: i + 1, level: m[1]!.length, text: m[2]! })
  })
  return out
}

interface Block { startLine: number, endLine: number, text: string, heading: string }

/**
 * The block under a heading up to the next heading of the same or a higher
 * level, without the blank lines and page break that separate it from the next.
 */
function blockAt(text: string, h: Heading): Block {
  const lines = text.split('\n')
  const next = headings(text).find(o => o.line > h.line && o.level <= h.level)
  let end = next ? next.line - 1 : lines.length
  while (end > h.line && (lines[end - 1]!.trim() === '' || lines[end - 1] === '<!-- pagebreak -->')) end -= 1
  return { startLine: h.line, endLine: end, text: lines.slice(h.line - 1, end).join('\n'), heading: h.text }
}

function chapter(text: string, no: number): Block {
  const h = headings(text).find(o => o.level === 1 && o.text.startsWith(`${no} `))
  if (!h) throw new Error(`chapter ${no} not found`)
  return blockAt(text, h)
}

function sections(text: string): Block[] {
  return headings(text).filter(h => h.level === 2).map(h => blockAt(text, h))
}

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

/** Renumber a chapter's headings (`# 4`, `## 4.1`, `### 4.1.2`) from `from` to `to`. */
function renumber(block: string, from: number, to: number): string {
  return block.replace(new RegExp(`^(#{1,3}) ${from}(?=[ .])`, 'gm'), `$1 ${to}`)
}

/**
 * A same-length stand-in for a model rewrite (translation, tone): shifts the
 * vowels of every prose line. Lines with links / images are left alone, so no
 * URL changes (the loop refuses edits that add unseen image URLs), and code
 * fences stay intact.
 */
function fakeRewrite(block: string): string {
  const shift: Record<string, string> = { a: 'e', e: 'i', i: 'o', o: 'u', u: 'a' }
  let inFence = false
  return block.split('\n').map((line) => {
    if (line.startsWith('```')) inFence = !inFence
    if (inFence || line.startsWith('```') || line.includes('](') || line.startsWith('|') || line.startsWith('#')) return line
    return line.replace(/[aeiou]/g, c => shift[c] ?? c)
  }).join('\n')
}

// Tasks

const T1_REVIEW: BenchTask = {
  id: 'T1-review-chapter',
  variant: VARIANT,
  title: 'Review chapter 13, five comments',
  prompt: 'Lies Kapitel 13 und hinterlasse fünf konkrete Verbesserungsvorschläge als Kommentare.',
  async script(api) {
    const reader = await openDocument(api)
    const ch = await readBlock(api, reader, rowByNumber(reader, '13'))
    const prose: number[] = []
    for (let l = ch.startLine; l <= ch.endLine; l++) {
      const line = reader.known.get(l)!
      if (line.length > 200 && !line.startsWith('|') && !line.startsWith('#')) prose.push(l)
    }
    const picks = [0, 1, 2, 3, 4].map(i => prose[Math.floor((i + 0.5) * prose.length / 5)]!)
    await api.turn(picks.map((line, i) => ({
      name: 'create_comment',
      args: {
        start_line: line,
        end_line: line,
        body: `Vorschlag ${i + 1}: Dieser Absatz wiederholt Vorgaben aus anderen Kapiteln, ohne sie auf Audits zu beziehen. Bitte konkret sagen, wer was bis wann prüft, und auf die Fristen in Abschnitt 13.2 verweisen. Ein kurzes Beispiel aus dem letzten Audit würde die Regel greifbarer machen.`
      }
    })))
  },
  verify: (_initial, final) => (final.length === _initial.length ? null : 'document text changed')
}

const T2_SWAP: BenchTask = {
  id: 'T2-swap-chapters',
  variant: VARIANT,
  title: 'Swap chapters 4 and 5',
  prompt: 'Vertausche die Kapitel 4 und 5 und passe die Nummerierung der Überschriften an.',
  async script(api) {
    const reader = await openDocument(api)
    const row4 = rowByNumber(reader, '4')
    const row5 = rowByNumber(reader, '5')
    await readSections(api, reader, [row4, row5])
    const ch4 = blockOf(reader, row4).text
    const ch5 = blockOf(reader, row5).text
    // Renumbered, the moved chapters differ from the originals, so the second
    // old_str (the original chapter 5) is still unique after the first edit.
    await api.turn([
      { name: 'replace_text', args: { old_str: ch4, new_str: renumber(ch5, 5, 4) } },
      { name: 'replace_text', args: { old_str: ch5, new_str: renumber(ch4, 4, 5) } }
    ])
  },
  verify: (initial, final) => {
    const want = chapter(initial, 5).text
    return chapter(final, 4).text === renumber(want, 5, 4) && chapter(final, 5).text === renumber(chapter(initial, 4).text, 4, 5)
      ? null
      : 'chapters not swapped'
  }
}

const T3_SHORTEN_INTRO: BenchTask = {
  id: 'T3-shorten-intro',
  variant: VARIANT,
  title: 'Shorten the introduction (chapter 1)',
  prompt: 'Kürze die Einleitung (Kapitel 1) auf etwa ein Drittel, ohne die Abschnittsstruktur zu verlieren.',
  async script(api) {
    const reader = await openDocument(api)
    const ch = (await readBlock(api, reader, rowByNumber(reader, '1'))).text
    // Keep every heading and the first paragraph under it.
    const kept: string[] = []
    let takeNext = false
    for (const para of ch.split('\n\n')) {
      if (para.startsWith('#')) {
        kept.push(para)
        takeNext = true
      } else if (takeNext && !para.startsWith('[^')) {
        kept.push(para.replace(/\[\^\d+\]/g, ''))
        takeNext = false
      }
    }
    await api.call('replace_text', { old_str: ch, new_str: kept.join('\n\n') })
  },
  verify: (initial, final) => (words(chapter(final, 1).text) < words(chapter(initial, 1).text) / 2 ? null : 'chapter 1 not shortened')
}

/** Section 9.2, about 1500 words in the default fixture (the translation target). */
function translationSection(text: string): Block {
  const section = sections(text).find(s => s.heading.startsWith('9.2 '))
  if (!section) throw new Error('section 9.2 not found')
  return section
}

const T4_TRANSLATE: BenchTask = {
  id: 'T4-translate-section',
  variant: VARIANT,
  title: 'Translate section 9.2 (~1500 words) to French',
  prompt: 'Übersetze den Abschnitt 9.2 «Alarmierung» ins Französische.',
  async script(api) {
    // The section is named in the prompt: read it straight away, no outline.
    const reader: DocReader = { rows: [], known: new Map() }
    const res = await api.call('read_section', { section: '9.2', max_chars: READ_MAX_CHARS })
    let next = absorbRead(reader, res)
    while (next) next = absorbRead(reader, await api.call(next.name, next.args))
    const range = /\(lines (\d+)-(\d+),/.exec(res.output)!
    const row: OutlineRow = { id: '', number: '9.2', level: 2, title: '', start: Number(range[1]), end: Number(range[2]), words: 0 }
    const section = blockOf(reader, row)
    await api.call('replace_text', { old_str: section.text, new_str: fakeRewrite(section.text) })
  },
  verify: (initial, final) => {
    const section = translationSection(initial)
    return final.includes(fakeRewrite(section.text)) ? null : 'section not replaced'
  }
}

const CUSTOMER_FORMS: Record<string, string> = { Kunde: 'Klient', Kunden: 'Klienten', Kundin: 'Klientin', Kundinnen: 'Klientinnen' }
const CUSTOMER_RE = /\bKund(?:e|en|in|innen)\b/g
/** Characters search_document shows on each side of a match. */
const SNIPPET_CONTEXT = 50

interface Hit { start: number, end: number, lineStart: number, lineEnd: number }

/**
 * The shortest word-bounded window around the hits of one line that is
 * unique in `text`, and how far it reaches past the outer hits. One edit per
 * line, so no two edits overlap.
 */
function uniqueWindow(text: string, lineHits: readonly Hit[]): { snippet: string, pad: number } {
  const first = lineHits[0]!
  const last = lineHits[lineHits.length - 1]!
  for (let pad = 20; ; pad += 20) {
    let start = Math.max(first.lineStart, first.start - pad)
    let end = Math.min(first.lineEnd, last.end + pad)
    while (start > first.lineStart && !/\s/.test(text[start - 1]!)) start -= 1
    while (end < first.lineEnd && !/\s/.test(text[end]!)) end += 1
    const snippet = text.slice(start, end)
    if (text.indexOf(snippet) === text.lastIndexOf(snippet)) return { snippet, pad }
    if (start === first.lineStart && end === first.lineEnd) throw new Error('line not unique')
  }
}

const T5_RENAME: BenchTask = {
  id: 'T5-rename-term',
  variant: VARIANT,
  title: 'Rename Kunde to Klient in all forms (40x)',
  prompt: 'Ersetze im ganzen Dokument «Kunde» durch «Klient», in allen Formen (Kunden, Kundin, Kundinnen).',
  async script(api) {
    // search_document lists every occurrence with its line and 50 characters
    // of context on each side; old_str is built from that context. Where it
    // is not unique, the model first reads the whole line (view_document).
    const found = await api.call('search_document', { query: String.raw`Kund(e|en|in|innen)\b`, regex: true, caseSensitive: true, limit: 200 })
    if (!/^40 matches/.test(found.output)) throw new Error(`unexpected search result: ${found.output.slice(0, 200)}`)
    const text = api.docText()
    const lineStarts = [0]
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1)
    const hits: Hit[] = [...text.matchAll(CUSTOMER_RE)].map((m) => {
      let line = 0
      while (line + 1 < lineStarts.length && lineStarts[line + 1]! <= m.index) line++
      const lineStart = lineStarts[line]!
      const lineEnd = line + 1 < lineStarts.length ? lineStarts[line + 1]! - 1 : text.length
      return { start: m.index, end: m.index + m[0].length, lineStart, lineEnd }
    })
    const byLine = new Map<number, Hit[]>()
    for (const h of hits) byLine.set(h.lineStart, [...(byLine.get(h.lineStart) ?? []), h])
    const edits: Array<{ old_str: string, new_str: string }> = []
    const lineReads = new Set<number>()
    for (const [lineStart, lineHits] of byLine) {
      const { snippet, pad } = uniqueWindow(text, lineHits)
      // The snippets show 50 characters around each match; a wider window
      // (or one spanning far-apart matches) needs the whole line first.
      const gaps = lineHits.slice(1).some((h, k) => h.start - lineHits[k]!.end > 2 * SNIPPET_CONTEXT)
      if (pad > SNIPPET_CONTEXT || gaps) lineReads.add(lineStarts.indexOf(lineStart) + 1)
      edits.push({ old_str: snippet, new_str: snippet.replace(CUSTOMER_RE, w => CUSTOMER_FORMS[w] ?? w) })
    }
    if (lineReads.size > 0) await api.turn([...lineReads].map(line => ({ name: 'view_document', args: { view_range: [line, line] } })))
    for (let k = 0; k < edits.length; k += 10) {
      await api.turn(edits.slice(k, k + 10).map(args => ({ name: 'replace_text', args })))
    }
  },
  verify: (_initial, final) => {
    const left = final.match(CUSTOMER_RE)?.length ?? 0
    const klient = final.match(/\bKlient(?:en|in|innen)?\b/g)?.length ?? 0
    return left === 0 && klient === 40 ? null : `${left} left, ${klient} renamed`
  }
}

const T6_FORMAL_TONE: BenchTask = {
  id: 'T6-formal-tone',
  variant: VARIANT,
  title: 'Formal tone across the whole document',
  prompt: 'Formuliere das ganze Dokument in einem formelleren, sachlicheren Ton um.',
  async script(api: ScriptApi) {
    const reader = await openDocument(api)
    const total = api.docText().length
    const h2 = reader.rows.filter(r => r.level === 2)
    let done = 0
    // One H2 section per turn, in document order, until the loop stops us:
    // each turn rewrites the section read last turn and reads the next one
    // (the stand-in rewrite keeps every line count, so no line shifts).
    await readSections(api, reader, [h2[0]!])
    for (let i = 0; i < h2.length; i++) {
      const section = blockOf(reader, h2[i]!)
      done += section.text.length
      api.reportProgress(done / total)
      const rewrite = { name: 'replace_text', args: { old_str: section.text, new_str: fakeRewrite(section.text) } }
      const next = h2[i + 1]
      if (next) await readSections(api, reader, [next], [rewrite])
      else await api.turn([rewrite])
    }
  }
}

const T7_ADD_TABLE: BenchTask = {
  id: 'T7-add-table',
  variant: VARIANT,
  title: 'Add a table to chapter 2',
  prompt: 'Füge am Ende von Kapitel 2 eine Tabelle mit den vier Teams, ihren Aufgaben und ihren Leitungen ein.',
  async script(api) {
    const reader = await openDocument(api)
    const row = rowByNumber(reader, '2')
    // Only the end of the chapter is needed to place the table.
    absorbRead(reader, await api.call('read_section', { section: row.id, offset_line: Math.max(row.start, row.end - 15) }))
    await api.call('insert_text', {
      insert_line: trimmedEnd(reader, row),
      insert_text: [
        'Table: Teams der Abteilung Betrieb',
        '',
        '| Team | Aufgaben | Leitung |',
        '|:--|:--|:--|',
        '| Netzleitstelle | Netzführung, Schalthandlungen, Störungskoordination | Reto Hänggi |',
        '| Rechenzentrum | Server, Speicher, Sicherungen | Lea Bachmann |',
        '| Netzwerk | Weitverkehrsnetz, Glasfaser, Segmentierung | Samuel Gerber |',
        '| Servicedesk | Anfragen, Störungsannahme, Information | Nadia Imhof |'
      ].join('\n')
    })
  },
  verify: (_initial, final) => (chapter(final, 2).text.includes('Table: Teams der Abteilung Betrieb') ? null : 'table not in chapter 2')
}

export const BASELINE_TASKS: readonly BenchTask[] = [
  T1_REVIEW,
  T2_SWAP,
  T3_SHORTEN_INTRO,
  T4_TRANSLATE,
  T5_RENAME,
  T6_FORMAL_TONE,
  T7_ADD_TABLE
]
