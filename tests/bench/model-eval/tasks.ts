import { diffLines } from 'diff'
import { BROKEN_HEADINGS_DOC, PAPER_DOC } from './fixtures'

// Planner task suite for the live model eval. Each task checks the final
// document (and comments) automatically; `score` is partial credit 0..1,
// `ok` the strict pass.

export interface EvalComment { body: string, anchorStart: number | null, anchorEnd: number | null }

export interface Verdict { ok: boolean, score: number, detail: string }

export interface PlannerTask {
  id: string
  doc: 'large' | 'broken-headings' | 'paper'
  language: string
  audience: string
  title: string
  prompt: string
  verify: (initial: string, final: string, comments: EvalComment[]) => Verdict
}

export function smallDocText(doc: PlannerTask['doc']): string | null {
  if (doc === 'broken-headings') return BROKEN_HEADINGS_DOC
  if (doc === 'paper') return PAPER_DOC
  return null
}

// Helpers

const FENCE = /^(```|~~~)/
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/m

/** Heading lines outside code fences: { line index, level, text }. */
export function headings(text: string): Array<{ i: number, level: number, text: string }> {
  const out: Array<{ i: number, level: number, text: string }> = []
  let inFence = false
  text.split('\n').forEach((line, i) => {
    if (FENCE.test(line)) inFence = !inFence
    if (inFence) return
    const m = /^(#{1,6}) (.*)$/.exec(line)
    if (m) out.push({ i, level: m[1]!.length, text: m[2]! })
  })
  return out
}

/** Top-level chapters `# N Title`: title (no number), number, char range. */
function chapters(text: string): Array<{ no: number | null, title: string, start: number, end: number, body: string }> {
  const lines = text.split('\n')
  const offsets: number[] = []
  let o = 0
  for (const l of lines) {
    offsets.push(o)
    o += l.length + 1
  }
  const h1 = headings(text).filter(h => h.level === 1)
  return h1.map((h, k) => {
    const m = /^(\d+) (.*?)(\s*\{#[^}]+\})?$/.exec(h.text)
    const start = offsets[h.i]!
    const end = k + 1 < h1.length ? offsets[h1[k + 1]!.i]! : text.length
    return { no: m ? Number(m[1]) : null, title: m ? m[2]! : h.text, start, end, body: text.slice(start, end) }
  })
}

/** Strip heading numbers, page breaks and blank lines, for content comparison. */
function normalizeChapter(body: string): string {
  return body.split('\n')
    .filter(l => l.trim() !== '' && l.trim() !== '<!-- pagebreak -->')
    .map(l => l.replace(/^(#{1,6}) \d+(\.\d+)* /, '$1 ').trimEnd())
    .join('\n')
}

function words(s: string): number {
  return s.split(/\s+/).filter(Boolean).length
}

/** Added and removed text between two versions. */
export function lineChanges(a: string, b: string): { added: string[], removed: string[] } {
  const added: string[] = []
  const removed: string[] = []
  for (const part of diffLines(a, b)) {
    if (part.added) added.push(part.value)
    else if (part.removed) removed.push(part.value)
  }
  return { added, removed }
}

/** 0-based line indices in `b` that the diff marks as added. */
function addedLineIndices(a: string, b: string): Set<number> {
  const out = new Set<number>()
  let line = 0
  for (const part of diffLines(a, b)) {
    const n = part.count ?? part.value.split('\n').length - 1
    if (part.removed) continue
    if (part.added) for (let k = 0; k < n; k++) out.add(line + k)
    line += n
  }
  return out
}

function lineIndexOf(text: string, pred: (l: string) => boolean): number {
  return text.split('\n').findIndex(pred)
}

// Tasks

export const PLANNER_TASKS: PlannerTask[] = [
  {
    id: 'L1-review-ch13',
    doc: 'large',
    language: 'de-CH',
    audience: 'technical',
    title: 'Review chapter 13 with comments',
    prompt: 'Lies Kapitel 13 und hinterlasse fünf konkrete Verbesserungsvorschläge als Kommentare an den passenden Stellen. Ändere den Text nicht.',
    verify: (initial, final, comments) => {
      const ch13 = chapters(initial).find(c => c.no === 13)!
      const inside = comments.filter(c => c.anchorStart !== null && c.anchorStart >= ch13.start && c.anchorStart < ch13.end).length
      const unchanged = final === initial
      const ok = unchanged && comments.length >= 3 && inside >= Math.ceil(comments.length * 0.8)
      const score = (unchanged ? 0.3 : 0) + 0.7 * Math.min(1, inside / 5)
      return { ok, score, detail: `comments=${comments.length} in_ch13=${inside} text_unchanged=${unchanged}` }
    }
  },
  {
    id: 'L2-swap-ch10-ch12',
    doc: 'large',
    language: 'de-CH',
    audience: 'technical',
    title: 'Swap chapters 10 and 12',
    prompt: 'Vertausche die Kapitel 10 und 12 und passe die Nummerierung der Überschriften an.',
    verify: (initial, final) => {
      const a = chapters(initial)
      const b = chapters(final)
      const titlesA = a.map(c => c.title)
      const expected = [...titlesA]
      const i10 = a.findIndex(c => c.no === 10)
      const i12 = a.findIndex(c => c.no === 12)
      ;[expected[i10], expected[i12]] = [expected[i12]!, expected[i10]!]
      const orderOk = JSON.stringify(b.map(c => c.title)) === JSON.stringify(expected)
      const numbered = b.filter(c => c.no !== null)
      const numberingOk = numbered.every((c, k) => c.no === k + 1)
      // Section numbers inside the moved chapters follow the chapter number.
      const subOk = b.filter(c => c.no !== null).every(c => headings(c.body).filter(h => h.level === 2 || h.level === 3)
        .every(h => !/^\d/.test(h.text) || h.text.startsWith(`${c.no}.`)))
      const byTitle = new Map(a.map(c => [c.title, normalizeChapter(c.body)]))
      const contentOk = b.every(c => byTitle.get(c.title) === normalizeChapter(c.body))
      const lengthRatio = final.length / initial.length
      const ok = orderOk && contentOk && numberingOk && subOk
      const score = (orderOk ? 0.4 : 0) + (contentOk ? 0.3 : 0) + (numberingOk ? 0.15 : 0) + (subOk ? 0.15 : 0)
      return { ok, score, detail: `order=${orderOk} content_preserved=${contentOk} chapter_numbers=${numberingOk} section_numbers=${subOk} length_ratio=${lengthRatio.toFixed(3)}` }
    }
  },
  {
    id: 'L3-rename-product',
    doc: 'large',
    language: 'de-CH',
    audience: 'technical',
    title: 'Rename the ticket system Kairos to Helix everywhere',
    prompt: 'Unser Ticketsystem heisst neu «Helix» statt «Kairos». Ersetze den Namen im ganzen Dokument.',
    verify: (initial, final) => {
      const total = (initial.match(/Kairos/g) ?? []).length
      const left = (final.match(/Kairos/g) ?? []).length
      const helix = (final.match(/Helix/g) ?? []).length
      // The CLI in a code block is `kairos ...`; renaming it too counts as clean.
      const clean = final.replaceAll('Helix', 'Kairos').replaceAll('helix', 'kairos') === initial
      const ok = left === 0 && clean
      const score = (1 - left / total) * (clean ? 1 : 0.7)
      return { ok, score, detail: `kairos_total=${total} left=${left} helix=${helix} only_name_changed=${clean}` }
    }
  },
  {
    id: 'L4-summary-table',
    doc: 'large',
    language: 'de-CH',
    audience: 'technical',
    title: 'Add a summary table at the end of section 9.3',
    prompt: 'Füge am Ende von Abschnitt 9.3 «Kennzahlen und Berechnung» eine Tabelle ein, die die wichtigsten Punkte dieses Abschnitts zusammenfasst.',
    verify: (initial, final) => {
      const { added, removed } = lineChanges(initial, final)
      const addedText = added.join('')
      const hasTable = /^\|.*\|\s*$/m.test(addedText) && TABLE_SEP.test(addedText)
      const start = lineIndexOf(final, l => l.startsWith('## 9.3 '))
      const end = lineIndexOf(final, l => l.startsWith('## 9.4 '))
      const lines = final.split('\n')
      const addedIdx = addedLineIndices(initial, final)
      const tableLine = lines.findIndex((l, i) => addedIdx.has(i) && TABLE_SEP.test(l))
      const placed = tableLine > start && tableLine < end
      // Inside the section's last 40 % or right before 9.4: "at the end".
      const nearEnd = placed && (end - tableLine) < Math.max(25, (end - start) * 0.4)
      const untouched = removed.length === 0
      const ok = hasTable && placed && untouched
      const score = (hasTable ? 0.4 : 0) + (placed ? 0.3 : 0) + (untouched ? 0.2 : 0) + (nearEnd ? 0.1 : 0)
      return { ok, score, detail: `table=${hasTable} in_9.3=${placed} near_end=${nearEnd} nothing_removed=${untouched} added_lines=${addedText.split('\n').length}` }
    }
  },
  {
    id: 'L5-rewrite-intro',
    doc: 'large',
    language: 'de-CH',
    audience: 'technical',
    title: 'Rewrite the chapter 1 intro paragraph shorter',
    prompt: 'Schreibe den einleitenden Absatz von Kapitel 1 (direkt unter der Überschrift «1 Einleitung») kürzer und klarer. Keine neuen Fakten, der Rest bleibt unverändert.',
    verify: (initial, final) => {
      const iLines = initial.split('\n')
      const h = iLines.findIndex(l => l.startsWith('# 1 Einleitung'))
      const s = iLines.findIndex(l => l.startsWith('## 1.1 '))
      const before = iLines.slice(h + 1, s).join('\n').trim()
      const fLines = final.split('\n')
      const fh = fLines.findIndex(l => l.startsWith('# 1 Einleitung'))
      const fs = fLines.findIndex(l => l.startsWith('## 1.1 '))
      const after = fh >= 0 && fs > fh ? fLines.slice(fh + 1, fs).join('\n').trim() : ''
      const restSame = fh >= 0 && fs > fh && iLines.slice(0, h + 1).join('\n') === fLines.slice(0, fh + 1).join('\n') && iLines.slice(s).join('\n') === fLines.slice(fs).join('\n')
      const shorter = after.length > 0 && words(after) < words(before)
      const ratio = words(before) ? words(after) / words(before) : 0
      const ok = restSame && shorter && ratio >= 0.3
      const score = (restSame ? 0.5 : 0) + (shorter ? 0.3 : 0) + (ratio >= 0.3 && ratio <= 0.85 ? 0.2 : 0)
      return { ok, score, detail: `rest_unchanged=${restSame} words ${words(before)}->${words(after)} ratio=${ratio.toFixed(2)}` }
    }
  },
  {
    id: 'S1-fix-heading-levels',
    doc: 'broken-headings',
    language: 'de-CH',
    audience: 'business',
    title: 'Fix heading levels (small doc)',
    prompt: 'Korrigiere die Überschriftenebenen in diesem Dokument, damit die Gliederung stimmt. Ändere sonst nichts.',
    verify: (initial, final) => {
      const hs = headings(final)
      const oneH1 = hs.filter(h => h.level === 1).length === 1 && hs[0]?.level === 1
      let jumps = 0
      for (let k = 1; k < hs.length; k++) if (hs[k]!.level > hs[k - 1]!.level + 1) jumps++
      const strip = (t: string): string => t.split('\n').map(l => l.replace(/^#{1,6} /, '')).filter(l => l.trim()).join('\n')
      const textSame = strip(initial) === strip(final)
      const ok = oneH1 && jumps === 0 && textSame
      const score = (oneH1 ? 0.35 : 0) + (jumps === 0 ? 0.35 : 0) + (textSame ? 0.3 : 0)
      return { ok, score, detail: `one_h1=${oneH1} jumps=${jumps} text_unchanged=${textSame} levels=${hs.map(h => h.level).join('')}` }
    }
  },
  {
    id: 'S2-write-abstract',
    doc: 'paper',
    language: 'en',
    audience: 'academic',
    title: 'Write an abstract (small doc)',
    prompt: 'Write an abstract of about 100 words for this paper and put it below the title.',
    verify: (initial, final) => {
      const { added, removed } = lineChanges(initial, final)
      const fLines = final.split('\n')
      const t = fLines.findIndex(l => l.startsWith('# '))
      const intro = fLines.findIndex(l => l.startsWith('## 1 Introduction'))
      const block = t >= 0 && intro > t ? fLines.slice(t + 1, intro).join('\n').replace(/^#+ .*$/gm, '').replace(/\*\*?Abstract:?\*\*?:?/i, '').trim() : ''
      const w = words(block)
      const placed = w > 0
      const sizeOk = w >= 60 && w <= 160
      const untouched = removed.length === 0
      const facts = ['2.9', '38', '150 kW', '6 %'].filter(f => block.includes(f)).length
      const ok = placed && sizeOk && untouched
      const score = (placed ? 0.4 : 0) + (sizeOk ? 0.3 : 0) + (untouched ? 0.3 : 0)
      return { ok, score, detail: `placed=${placed} words=${w} nothing_removed=${untouched} key_facts=${facts}/4 added_chunks=${added.length}` }
    }
  }
]

// Writing-rule rubric (report section 2.3), applied to text the model wrote.

const AI_VOCAB_EN = ['delve', 'tapestry', 'landscape', 'realm', 'crucial', 'pivotal', 'robust', 'seamless', 'vibrant', 'intricate', 'meticulous', 'showcase', 'underscore', 'foster', 'garner', 'bolster', 'leverage', 'testament', 'enduring', 'valuable insights', 'serves as', 'stands as', 'in conclusion', 'overall,', 'in summary', 'additionally,']
const AI_VOCAB_DE = ['entscheidend', 'massgeblich', 'maßgeblich', 'nahtlos', 'unterstreicht', 'unterstreichen', 'zentrale rolle', 'darüber hinaus', 'zusammenfassend', 'insgesamt', 'zudem', 'nicht nur', 'spielt eine', 'von grosser bedeutung', 'von großer bedeutung', 'gewährleistet', 'robust', 'vielfältig']

export interface WritingCheck { chars: number, emDash: number, doubleHyphenDash: number, vocab: string[], triads: number }

export function writingCheck(text: string): WritingCheck {
  const lower = text.toLowerCase()
  const vocab = [...AI_VOCAB_EN, ...AI_VOCAB_DE].filter(w => lower.includes(w))
  // "A, B und C" / "A, B and C" with short items: a candidate group of three.
  const triads = (text.match(/\b[\wäöüÄÖÜ-]+, [\wäöüÄÖÜ-]+,? (und|and|oder|or) [\wäöüÄÖÜ-]+\b/g) ?? []).length
  return { chars: text.length, emDash: (text.match(/\u2014/g) ?? []).length, doubleHyphenDash: (text.match(/ -- /g) ?? []).length, vocab, triads }
}
