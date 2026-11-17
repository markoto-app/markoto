import type { BenchTask, ScriptApi, ToolOutcome } from './harness'

// The benchmark tasks, scripted the way a competent model does them with
// TODAY's tools (view_document / replace_text / insert_text / create_comment).
// Each script plays the model: it reads the document from the real
// view_document result and builds old_str from it, so the edits really apply.
// A later variant re-scripts the same task ids with new tools; keep the ids
// and prompts stable so results stay comparable.

// Document helpers (what the model reads off the view_document output)

/** The document text from a `view_document` result ("N: line" per line). */
function textFromView(view: ToolOutcome | null): string {
  if (!view || view.isError) throw new Error('view_document failed')
  return view.output.split('\n').map(l => l.replace(/^\d+: /, '')).join('\n')
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
  variant: 'baseline',
  title: 'Review chapter 13, five comments',
  prompt: 'Lies Kapitel 13 und hinterlasse fünf konkrete Verbesserungsvorschläge als Kommentare.',
  async script(api) {
    const text = textFromView(await api.call('view_document', {}))
    const ch = chapter(text, 13)
    const lines = text.split('\n')
    const prose: number[] = []
    for (let l = ch.startLine; l <= ch.endLine; l++) {
      const line = lines[l - 1]!
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
  variant: 'baseline',
  title: 'Swap chapters 4 and 5',
  prompt: 'Vertausche die Kapitel 4 und 5 und passe die Nummerierung der Überschriften an.',
  async script(api) {
    const text = textFromView(await api.call('view_document', {}))
    const ch4 = chapter(text, 4).text
    const ch5 = chapter(text, 5).text
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
  variant: 'baseline',
  title: 'Shorten the introduction (chapter 1)',
  prompt: 'Kürze die Einleitung (Kapitel 1) auf etwa ein Drittel, ohne die Abschnittsstruktur zu verlieren.',
  async script(api) {
    const text = textFromView(await api.call('view_document', {}))
    const ch = chapter(text, 1).text
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
  variant: 'baseline',
  title: 'Translate section 9.2 (~1500 words) to French',
  prompt: 'Übersetze den Abschnitt 9.2 «Alarmierung» ins Französische.',
  async script(api) {
    const text = textFromView(await api.call('view_document', {}))
    const section = translationSection(text)
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
  variant: 'baseline',
  title: 'Rename Kunde to Klient in all forms (40x)',
  prompt: 'Ersetze im ganzen Dokument «Kunde» durch «Klient», in allen Formen (Kunden, Kundin, Kundinnen).',
  async script(api) {
    const text = textFromView(await api.call('view_document', {}))
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
  variant: 'baseline',
  title: 'Formal tone across the whole document',
  prompt: 'Formuliere das ganze Dokument in einem formelleren, sachlicheren Ton um.',
  async script(api: ScriptApi) {
    const text = textFromView(await api.call('view_document', {}))
    const total = text.length
    let done = 0
    // One H2 section per turn, in document order, until the loop stops us.
    for (const section of sections(text)) {
      done += section.text.length
      api.reportProgress(done / total)
      await api.call('replace_text', { old_str: section.text, new_str: fakeRewrite(section.text) })
    }
  }
}

const T7_ADD_TABLE: BenchTask = {
  id: 'T7-add-table',
  variant: 'baseline',
  title: 'Add a table to chapter 2',
  prompt: 'Füge am Ende von Kapitel 2 eine Tabelle mit den vier Teams, ihren Aufgaben und ihren Leitungen ein.',
  async script(api) {
    const text = textFromView(await api.call('view_document', {}))
    const ch = chapter(text, 2)
    await api.call('insert_text', {
      insert_line: ch.endLine,
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
