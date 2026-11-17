import type { BenchTask, ScriptApi, ScriptCall, ToolOutcome } from './harness'

// The benchmark tasks, scripted the way a competent model does them with
// the current tools (view_document / replace_text / insert_text /
// create_comment). Each script plays the model: it reads the document from
// the real view_document results and builds old_str from them, so the edits
// really apply. Variant `step1`: view_document on the large document returns
// a heading outline with line ranges, so the scripts read the outline and
// then only the ranges they need (`view_range`), following the continuation
// hints. Keep the ids and prompts stable so results stay comparable with
// `results/baseline.*`.

const VARIANT = 'step1'

// Reading the document through the outline (what the model reads off the
// view_document results)

interface OutlineRow { start: number, end: number, level: number, text: string }

interface DocReader {
  rows: OutlineRow[]
  totalLines: number
  /** Lines the outline says fit in one call. */
  perCall: number
  /** Lines read so far, by line number. */
  known: Map<number, string>
}

const NUMBERED_LINE_RE = /^(\d+): (.*)$/
const CONTINUE_RE = /Continue with view_document and view_range \[(\d+), (\d+)\]/

/** Record the "N: text" lines of a view_document result; returns the continuation range if it was cut. */
function absorbView(reader: DocReader, view: ToolOutcome | undefined): [number, number] | null {
  if (!view || view.isError) throw new Error(`view_document failed: ${view?.output.slice(0, 200)}`)
  const body = view.output.includes(' follow:\n\n') ? view.output.slice(view.output.indexOf(' follow:\n\n') + 10) : view.output
  for (const row of body.split('\n')) {
    const m = NUMBERED_LINE_RE.exec(row)
    if (m) reader.known.set(Number(m[1]), m[2]!)
  }
  const cont = CONTINUE_RE.exec(view.output)
  return cont ? [Number(cont[1]), Number(cont[2])] : null
}

/** First call: view_document without a range gives the outline (or the whole short document). */
async function openDocument(api: ScriptApi): Promise<DocReader> {
  const view = await api.call('view_document', {})
  const reader: DocReader = { rows: [], totalLines: 0, perCall: 0, known: new Map() }
  const total = /The document has (\d+) lines/.exec(view.output)
  if (!total) {
    absorbView(reader, view)
    reader.totalLines = reader.known.size
    reader.perCall = reader.totalLines
    return reader
  }
  reader.totalLines = Number(total[1])
  reader.perCall = Number(/about (\d+) lines fit in one call/.exec(view.output)?.[1] ?? 100)
  for (const row of view.output.split('\n')) {
    const m = /^\[(\d+)-(\d+)\] (#{1,6}) (.*)$/.exec(row)
    if (m) reader.rows.push({ start: Number(m[1]), end: Number(m[2]), level: m[3]!.length, text: m[4]! })
  }
  absorbView(reader, view)
  return reader
}

/** View calls covering [start, end] in chunks of the size the outline suggested. */
function rangeCalls(reader: DocReader, start: number, end: number): ScriptCall[] {
  const calls: ScriptCall[] = []
  for (let from = start; from <= end; from += reader.perCall) {
    calls.push({ name: 'view_document', args: { view_range: [from, Math.min(end, from + reader.perCall - 1)] } })
  }
  return calls
}

/**
 * Read every line of the given ranges that is not known yet: one turn with
 * all the view calls (plus `extra` calls in the same turn), then follow-up
 * turns for results that were cut. Returns the results of `extra`.
 */
async function readRanges(api: ScriptApi, reader: DocReader, ranges: Array<[number, number]>, extra: ScriptCall[] = []): Promise<ToolOutcome[]> {
  let calls: ScriptCall[] = []
  for (const [start, end] of ranges) {
    let from = start
    while (from <= end && reader.known.has(from)) from += 1
    if (from <= end) calls.push(...rangeCalls(reader, from, end))
  }
  let extraResults: ToolOutcome[] = []
  let first = true
  while (calls.length > 0 || (first && extra.length > 0)) {
    const results = await api.turn(first ? [...extra, ...calls] : calls)
    if (first) extraResults = results.slice(0, extra.length)
    const views = first ? results.slice(extra.length) : results
    first = false
    const next: ScriptCall[] = []
    views.forEach((view, i) => {
      const cont = absorbView(reader, view)
      const wanted = calls[i]!.args.view_range as [number, number]
      if (cont && cont[0] <= wanted[1]) next.push({ name: 'view_document', args: { view_range: [cont[0], wanted[1]] } })
    })
    calls = next
  }
  return extraResults
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

function outlineRow(reader: DocReader, level: number, prefix: string): OutlineRow {
  const row = reader.rows.find(r => r.level === level && r.text.startsWith(prefix))
  if (!row) throw new Error(`heading "${prefix}" not in the outline`)
  return row
}

/** Last line of a section without the blank lines and page break before the next heading. */
function trimmedEnd(reader: DocReader, row: OutlineRow): number {
  let end = row.end
  while (end > row.start && (reader.known.get(end)!.trim() === '' || reader.known.get(end) === '<!-- pagebreak -->')) end -= 1
  return end
}

/** Read a section (outline row) and return it as a block, like `blockAt` on the full text. */
async function readBlock(api: ScriptApi, reader: DocReader, row: OutlineRow): Promise<Block> {
  await readRanges(api, reader, [[row.start, row.end]])
  return blockOf(reader, row)
}

function blockOf(reader: DocReader, row: OutlineRow): Block {
  const end = trimmedEnd(reader, row)
  return { startLine: row.start, endLine: end, text: linesOf(reader, row.start, end).join('\n'), heading: row.text }
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
    const ch = await readBlock(api, reader, outlineRow(reader, 1, '13 '))
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
    const row4 = outlineRow(reader, 1, '4 ')
    const row5 = outlineRow(reader, 1, '5 ')
    await readRanges(api, reader, [[row4.start, row4.end], [row5.start, row5.end]])
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
    const ch = (await readBlock(api, reader, outlineRow(reader, 1, '1 '))).text
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
    const reader = await openDocument(api)
    const section = await readBlock(api, reader, outlineRow(reader, 2, '9.2 '))
    await api.call('replace_text', { old_str: section.text, new_str: fakeRewrite(section.text) })
  },
  verify: (initial, final) => {
    const section = translationSection(initial)
    return final.includes(fakeRewrite(section.text)) ? null : 'section not replaced'
  }
}

const CUSTOMER_FORMS: Record<string, string> = { Kunde: 'Klient', Kunden: 'Klienten', Kundin: 'Klientin', Kundinnen: 'Klientinnen' }
const CUSTOMER_RE = /\bKund(?:e|en|in|innen)\b/g

interface Hit { start: number, end: number }

/** The shortest word-bounded window around hits[i] that is unique in `text`, and the last hit it covers. */
function uniqueWindow(text: string, hits: readonly Hit[], i: number): { snippet: string, last: number } {
  let last = i
  for (let pad = 20; ; pad += 20) {
    let start = Math.max(0, hits[i]!.start - pad)
    let end = Math.min(text.length, hits[last]!.end + pad)
    while (start > 0 && !/\s/.test(text[start - 1]!)) start -= 1
    while (end < text.length && !/\s/.test(text[end]!)) end += 1
    // A following occurrence inside the window is replaced in the same call.
    while (hits[last + 1] && hits[last + 1]!.start < end) last += 1
    const snippet = text.slice(start, end)
    if (text.indexOf(snippet) === text.lastIndexOf(snippet)) return { snippet, last }
  }
}

/**
 * One replace_text per occurrence: the shortest word-bounded snippet around it
 * that is unique in the document; occurrences close together share one call.
 */
function customerEdits(text: string): Array<{ old_str: string, new_str: string }> {
  const hits = [...text.matchAll(CUSTOMER_RE)].map(m => ({ start: m.index, end: m.index + m[0].length }))
  const edits: Array<{ old_str: string, new_str: string }> = []
  for (let i = 0; i < hits.length;) {
    const { snippet, last } = uniqueWindow(text, hits, i)
    edits.push({ old_str: snippet, new_str: snippet.replace(CUSTOMER_RE, w => CUSTOMER_FORMS[w] ?? w) })
    i = last + 1
  }
  return edits
}

const T5_RENAME: BenchTask = {
  id: 'T5-rename-term',
  variant: VARIANT,
  title: 'Rename Kunde to Klient in all forms (40x)',
  prompt: 'Ersetze im ganzen Dokument «Kunde» durch «Klient», in allen Formen (Kunden, Kundin, Kundinnen).',
  async script(api) {
    // No search tool yet: the whole document has to be read, in parallel
    // ranged reads.
    const reader = await openDocument(api)
    await readRanges(api, reader, [[1, reader.totalLines]])
    const text = linesOf(reader, 1, reader.totalLines).join('\n')
    const edits = customerEdits(text)
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
    const total = Number(/\((\d+) characters\)/.exec(api.lastResult?.output ?? '')?.[1] ?? 1)
    const h2 = reader.rows.filter(r => r.level === 2)
    let done = 0
    // One H2 section per turn, in document order, until the loop stops us:
    // each turn rewrites the section read last turn and reads the next one
    // (the stand-in rewrite keeps every line count, so no line shifts).
    await readRanges(api, reader, [[h2[0]!.start, h2[0]!.end]])
    for (let i = 0; i < h2.length; i++) {
      const section = blockOf(reader, h2[i]!)
      done += section.text.length
      api.reportProgress(done / total)
      const rewrite = { name: 'replace_text', args: { old_str: section.text, new_str: fakeRewrite(section.text) } }
      const next = h2[i + 1]
      if (next) await readRanges(api, reader, [[next.start, next.end]], [rewrite])
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
    const row = outlineRow(reader, 1, '2 ')
    // Only the end of the chapter is needed to place the table.
    await readRanges(api, reader, [[Math.max(row.start, row.end - 15), row.end]])
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
