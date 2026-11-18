import type { BenchTask, ScriptApi, ScriptCall, ToolOutcome } from './harness'

// The benchmark tasks, scripted the way a competent model does them with
// the current tools. Each script plays the model: it reads the document from
// the real tool results and builds old_str from them, so the edits really
// apply. Variant `step4`: the scripts start with `outline` (section ids,
// numbers, line ranges), read what they need with `read_section` (several
// sections in one turn, following the continuation hints) and find terms
// with `search_document`. Variant `step5` adds the structural edit tools:
// T2 moved a chapter with `move_section` (variant `final`: swaps both with
// `swap_sections`) and renumbers its headings with `replace_all` (regex,
// scoped), T3 rewrites with `replace_section`, T5
// renames with `replace_all` (two patterns, preview then apply), T7 places
// the table with `insert_markdown`. Keep the ids and prompts stable so
// results stay comparable with `results/baseline.*` and the earlier variants.

const VARIANT = 'step5'

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

/** Renamed headings get their old anchor pinned as `{#h-4-...}`; the swap check ignores those pins. */
function withoutPinnedAnchors(text: string): string {
  return text.replaceAll(/ \{#h-\d[^\s{}]*\}/g, '')
}

/** Renumber a chapter in place: preview, then apply, scoped to its section id. */
function renumberCalls(id: string, from: number, to: number, preview: boolean): ScriptCall {
  return { name: 'replace_all', args: { query: `^(#{1,3}) ${from}(?=[ .])`, regex: true, caseSensitive: true, replacement: `$1 ${to}`, scope: id, preview } }
}

const T2_SWAP: BenchTask = {
  id: 'T2-swap-chapters',
  variant: 'final',
  title: 'Swap chapters 4 and 5',
  prompt: 'Vertausche die Kapitel 4 und 5 und passe die Nummerierung der Überschriften an.',
  async script(api) {
    const reader = await openDocument(api)
    const row4 = rowByNumber(reader, '4')
    const row5 = rowByNumber(reader, '5')
    // Server-side swap in one call: no chapter text in the model's output.
    const swapped = await api.call('swap_sections', { a: row4.id, b: row5.id })
    if (swapped.isError) throw new Error(`swap failed: ${swapped.output.slice(0, 200)}`)
    // Ids stay with their sections; renumber each chapter's headings, preview first.
    await api.turn([renumberCalls(row5.id, 5, 4, true), renumberCalls(row4.id, 4, 5, true)])
    const applied = await api.turn([renumberCalls(row5.id, 5, 4, false), renumberCalls(row4.id, 4, 5, false)])
    for (const r of applied) if (!r || r.isError) throw new Error(`renumber failed: ${r?.output.slice(0, 200)}`)
  },
  verify: (initial, final) => {
    const clean = withoutPinnedAnchors(final)
    const want = chapter(initial, 5).text
    return chapter(clean, 4).text === renumber(want, 5, 4) && chapter(clean, 5).text === renumber(chapter(initial, 4).text, 4, 5)
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
    await api.call('replace_section', { section: rowByNumber(reader, '1').id, markdown: kept.join('\n\n'), keep_heading: false })
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

const CUSTOMER_RE = /\bKund(?:e|en|in|innen)\b/g

const T5_RENAME: BenchTask = {
  id: 'T5-rename-term',
  variant: VARIANT,
  title: 'Rename Kunde to Klient in all forms (40x)',
  prompt: 'Ersetze im ganzen Dokument «Kunde» durch «Klient», in allen Formen (Kunden, Kundin, Kundinnen).',
  async script(api) {
    // search_document shows every occurrence; the forms map mechanically
    // (Kunde → Klient, Kund-en/-in/-innen → Klient-en/-in/-innen), so two
    // replace_all patterns cover them: preview both, then apply both.
    const found = await api.call('search_document', { query: String.raw`Kund(e|en|in|innen)\b`, regex: true, caseSensitive: true, limit: 30 })
    if (!/^40 matches/.test(found.output)) throw new Error(`unexpected search result: ${found.output.slice(0, 200)}`)
    const calls = (preview: boolean): ScriptCall[] => [
      { name: 'replace_all', args: { query: String.raw`\bKunde\b`, regex: true, caseSensitive: true, replacement: 'Klient', preview } },
      { name: 'replace_all', args: { query: String.raw`\bKund(en|in|innen)\b`, regex: true, caseSensitive: true, replacement: 'Klient$1', preview } }
    ]
    await api.turn(calls(true))
    const applied = await api.turn(calls(false))
    for (const r of applied) if (!r || r.isError) throw new Error(`replace_all failed: ${r?.output.slice(0, 200)}`)
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
    // insert_markdown places it at the end of the chapter: nothing to read first.
    await api.call('insert_markdown', {
      section: row.id,
      position: 'end',
      markdown: [
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

// Variant `step8`: the rule-like rewrites go to a delegated job
// (`delegate_rewrite`). The planner previews, starts and reports; the
// worker calls are modelled by `jobModel.ts` and reported separately.

/** The job id from a delegate_rewrite preview result. */
function jobIdOf(res: ToolOutcome): string {
  const m = /^job_id: (\S+)$/m.exec(res.output)
  if (res.isError || !m) throw new Error(`delegate_rewrite preview failed: ${res.output.slice(0, 200)}`)
  return m[1]!
}

const T4_TRANSLATE_DELEGATED: BenchTask = {
  id: 'T4-translate-section',
  variant: 'step8',
  title: 'Translate section 9.2 (~1500 words) to French, delegated',
  prompt: T4_TRANSLATE.prompt,
  async script(api) {
    const preview = await api.call('delegate_rewrite', { targets: ['9.2'], mode: 'translate', target_language: 'French', instruction: 'Translate faithfully into French; keep names, product names and numbers.', preview: 1 })
    const started = await api.call('delegate_rewrite', { job_id: jobIdOf(preview), action: 'start' })
    if (started.isError) throw new Error(`start failed: ${started.output.slice(0, 200)}`)
    await api.call('message_to_user', { message: 'Section 9.2 is being translated into French in the background; you can follow it above the prompt bar and undo it in the Activity Log.' })
  }
}

const T6_FORMAL_TONE_DELEGATED: BenchTask = {
  id: 'T6-formal-tone',
  variant: 'step8',
  title: 'Formal tone across the whole document, delegated',
  prompt: T6_FORMAL_TONE.prompt,
  async script(api) {
    await openDocument(api)
    const preview = await api.call('delegate_rewrite', { targets: 'all', mode: 'rewrite', instruction: 'Raise the register to formal, factual German: no colloquial phrases, no second person; keep content, numbers, names and structure.', preview: 2 })
    const started = await api.call('delegate_rewrite', { job_id: jobIdOf(preview), action: 'start' })
    if (started.isError) throw new Error(`start failed: ${started.output.slice(0, 200)}`)
    api.reportProgress(1)
    await api.call('message_to_user', { message: 'The whole document is being rewritten in a more formal tone in the background; progress shows above the prompt bar, and Undo is in the Activity Log.' })
  }
}

export const BASELINE_TASKS: readonly BenchTask[] = [
  T1_REVIEW,
  T2_SWAP,
  T3_SHORTEN_INTRO,
  T4_TRANSLATE,
  T5_RENAME,
  T6_FORMAL_TONE,
  T7_ADD_TABLE,
  T4_TRANSLATE_DELEGATED,
  T6_FORMAL_TONE_DELEGATED
]
