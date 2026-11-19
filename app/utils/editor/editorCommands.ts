import type { EditorView, KeyBinding } from '@codemirror/view'
import type { ChangeSpec } from '@codemirror/state'

/**
 * Editor command helpers for the formatting toolbar + menu bar.
 *
 * Rules every helper follows:
 *
 *  1. **Idempotent.** Repeating an action on the same selection toggles;
 *     markers (`****foo****`) and prefixes (`# ## Foo`) never accumulate.
 *
 *  2. **Whitespace-safe.** Wrapping `  foo  ` puts the markers OUTSIDE the
 *     trimmed range (`  **foo**  `), which is valid markdown.
 *     Whitespace-only selections behave like an empty one (a marker pair,
 *     cursor inside).
 *
 *  3. **Per-line for line-anchored ops.** Headings, lists and quotes apply
 *     to every non-blank line of the selection; blank lines are skipped.
 *
 *  4. **Per-line for inline wraps on multi-line selections.** Each
 *     non-blank line gets the marker individually.
 *
 *  5. **Mixed-state policy.** When some lines already have the
 *     marker/prefix and some don't, add it to the missing ones; toggle off
 *     only when ALL non-blank lines have it. A click is never a partial
 *     change.
 *
 *  6. **Disambiguation.** Single-char markers (`*` italic, `~` sub) never
 *     steal from doubled ones (`**` bold, `~~` strike): italic on
 *     `**foo**` gives `***foo***`.
 *
 *  7. **Code is special.** `toggleCode` uses inline backticks for a single
 *     line and a fenced ` ``` ` block for multiple lines.
 */

interface LineInfo { from: number, to: number, text: string, number: number }

function linesInPrimarySelection(view: EditorView): LineInfo[] {
  const { from, to } = view.state.selection.main
  const startLine = view.state.doc.lineAt(from).number
  const endLine = view.state.doc.lineAt(to).number
  const out: LineInfo[] = []
  for (let i = startLine; i <= endLine; i++) {
    const line = view.state.doc.line(i)
    out.push({ from: line.from, to: line.to, text: line.text, number: i })
  }
  return out
}

const isBlank = (s: string) => s.trim().length === 0

const BLOCK_PREFIX_RE = /^(\s*)([-*]\s+\[[ xX]\]\s+|[-*]\s+|\d+\.\s+|>\s+)/
const HEADING_PREFIX_RE = /^(#{1,6})\s+/

function leadingWhitespace(text: string): string {
  return text.slice(0, text.length - text.trimStart().length)
}

/**
 * Wrap/unwrap one selection range with `marker`. Returns a ChangeSpec
 * list instead of dispatching so callers can batch.
 */
function wrapRangeChanges(
  view: EditorView,
  from: number,
  to: number,
  marker: string
): { changes: ChangeSpec[], finalFrom: number, finalTo: number } | null {
  const docLen = view.state.doc.length
  const selected = view.state.sliceDoc(from, to)
  const leading = leadingWhitespace(selected)
  // trimEnd removes the exact same character set `\s` matches; computing
  // the suffix this way avoids the super-linear backtracking of /\s*$/.
  const trailing = selected.slice(selected.trimEnd().length)
  const trimmed = selected.slice(leading.length, selected.length - trailing.length)

  if (trimmed.length === 0) {
    if (from === to) {
      // Empty cursor: marker pair with the cursor between.
      return {
        changes: [{ from, to, insert: marker + marker }],
        finalFrom: from + marker.length,
        finalTo: from + marker.length
      }
    }
    return null // skip whitespace-only inside a multi-line batch
  }

  const trimFrom = from + leading.length
  const trimTo = to - trailing.length

  // Markers adjacent to the trimmed range.
  const before = view.state.sliceDoc(Math.max(0, trimFrom - marker.length), trimFrom)
  const after = view.state.sliceDoc(trimTo, Math.min(docLen, trimTo + marker.length))
  let wrappedOutside = before === marker && after === marker

  // `*`/`~` must not steal from `**`/`~~`.
  if (wrappedOutside && marker.length === 1 && (marker === '*' || marker === '~')) {
    const outerBefore = view.state.sliceDoc(Math.max(0, trimFrom - 2), trimFrom - 1)
    const outerAfter = view.state.sliceDoc(trimTo + 1, Math.min(docLen, trimTo + 2))
    if (outerBefore === marker || outerAfter === marker) wrappedOutside = false
  }

  if (wrappedOutside) {
    return {
      changes: [
        { from: trimFrom - marker.length, to: trimTo + marker.length, insert: trimmed }
      ],
      finalFrom: trimFrom - marker.length,
      finalTo: trimFrom - marker.length + trimmed.length
    }
  }

  // Trimmed text starts AND ends with the marker (selection dragged
  // across the wrappers).
  let insideWrap = trimmed.length >= marker.length * 2
    && trimmed.startsWith(marker) && trimmed.endsWith(marker)
  if (insideWrap && marker.length === 1 && (marker === '*' || marker === '~')) {
    if (trimmed[marker.length] === marker
      || trimmed[trimmed.length - marker.length - 1] === marker) {
      insideWrap = false
    }
  }

  if (insideWrap) {
    const stripped = trimmed.slice(marker.length, trimmed.length - marker.length)
    return {
      changes: [{ from, to, insert: leading + stripped + trailing }],
      finalFrom: from + leading.length,
      finalTo: from + leading.length + stripped.length
    }
  }

  return {
    changes: [{ from, to, insert: leading + marker + trimmed + marker + trailing }],
    finalFrom: trimFrom + marker.length,
    finalTo: trimTo + marker.length
  }
}

/**
 * `**bold**`, `*italic*`, `~~strike~~`, `==mark==`, `++ins++`, `~sub~`,
 * `^sup^`, `` `code` ``. Per-line on multi-line selections (each line
 * wrapped/unwrapped individually; blank lines skipped; mixed state →
 * wrap the missing ones).
 */
export function toggleWrap(view: EditorView, marker: string): void {
  const { from, to } = view.state.selection.main
  const selected = view.state.sliceDoc(from, to)

  if (!selected.includes('\n')) {
    const result = wrapRangeChanges(view, from, to, marker)
    if (!result) return
    view.dispatch({
      changes: result.changes,
      selection: { anchor: result.finalFrom, head: result.finalTo }
    })
    view.focus()
    return
  }

  const lines = linesInPrimarySelection(view)
  const nonBlank = lines.filter(l => !isBlank(l.text))
  if (nonBlank.length === 0) return

  const wrappedTrimmed = (text: string) => {
    const trimmed = text.trim()
    if (trimmed.length < marker.length * 2) return false
    if (!trimmed.startsWith(marker) || !trimmed.endsWith(marker)) return false
    if (marker.length === 1 && (marker === '*' || marker === '~')) {
      // Don't treat `**foo**` as italic-wrapped.
      if (trimmed[marker.length] === marker
        || trimmed[trimmed.length - marker.length - 1] === marker) return false
    }
    return true
  }

  const allWrapped = nonBlank.every(l => wrappedTrimmed(l.text))
  const changes: ChangeSpec[] = []

  for (const line of nonBlank) {
    const text = line.text
    const leading = leadingWhitespace(text)
    const trailing = text.slice(text.trimEnd().length)
    const trimmed = text.slice(leading.length, text.length - trailing.length)

    if (allWrapped) {
      const stripped = trimmed.slice(marker.length, trimmed.length - marker.length)
      changes.push({ from: line.from, to: line.to, insert: leading + stripped + trailing })
    } else {
      // Only lines that don't already have it.
      if (wrappedTrimmed(text)) continue
      changes.push({
        from: line.from,
        to: line.to,
        insert: leading + marker + trimmed + marker + trailing
      })
    }
  }

  if (changes.length === 0) return
  view.dispatch({ changes })
  view.focus()
}

/**
 * Inline backticks for single-line selections; fenced ` ``` ` block for
 * multi-line. The fenced toggle detects an existing fence above/below
 * the selection and strips it; otherwise wraps the selection in a new
 * fence.
 */
export function toggleCode(view: EditorView): void {
  const { from, to } = view.state.selection.main
  const selected = view.state.sliceDoc(from, to)

  if (!selected.includes('\n')) {
    return toggleWrap(view, '`')
  }

  const startLine = view.state.doc.lineAt(from)
  const endLine = view.state.doc.lineAt(to)

  const fenceOpen = /^```\w*\s*$/
  const fenceClose = /^```\s*$/

  // Case A: the selection includes the fence lines themselves; strip them
  // plus the adjoining newlines.
  if (fenceOpen.test(startLine.text) && fenceClose.test(endLine.text) && startLine.number < endLine.number) {
    const secondLine = view.state.doc.line(startLine.number + 1)
    const beforeLast = view.state.doc.line(endLine.number - 1)
    view.dispatch({
      changes: [
        { from: startLine.from, to: secondLine.from, insert: '' },
        { from: beforeLast.to, to: endLine.to, insert: '' }
      ]
    })
    view.focus()
    return
  }

  // Case B: the selection sits between fence lines.
  const lineBefore = startLine.number > 1 ? view.state.doc.line(startLine.number - 1) : null
  const lineAfter = endLine.number < view.state.doc.lines ? view.state.doc.line(endLine.number + 1) : null
  const fenceBefore = lineBefore && fenceOpen.test(lineBefore.text)
  const fenceAfter = lineAfter && fenceClose.test(lineAfter.text)

  if (fenceBefore && fenceAfter) {
    view.dispatch({
      changes: [
        { from: lineBefore.from, to: startLine.from, insert: '' },
        { from: endLine.to, to: lineAfter.to, insert: '' }
      ]
    })
    view.focus()
    return
  }

  view.dispatch({
    changes: [
      { from: startLine.from, insert: '```\n' },
      { from: endLine.to, insert: '\n```' }
    ]
  })
  view.focus()
}

/**
 * Heading toggle. Per-line on multi-line selections.
 *
 * Single line:
 *   - same level → strip prefix
 *   - different level → replace
 *   - no heading → prepend
 *
 * Multi-line:
 *   - all non-blank lines already at this level → strip all
 *   - otherwise → set all (replacing any existing heading prefix)
 *   - blank lines untouched
 */
export function toggleHeading(view: EditorView, level: number): void {
  const lines = linesInPrimarySelection(view)
  const nonBlank = lines.filter(l => !isBlank(l.text))
  if (nonBlank.length === 0) return

  const atLevel = (text: string) => {
    const m = HEADING_PREFIX_RE.exec(text)
    return m?.[1]?.length === level
  }
  const allAtLevel = nonBlank.every(l => atLevel(l.text))

  const changes: ChangeSpec[] = []
  for (const line of nonBlank) {
    const m = HEADING_PREFIX_RE.exec(line.text)
    const oldPrefixLen = m ? m[0].length : 0
    const newPrefix = allAtLevel ? '' : '#'.repeat(level) + ' '
    changes.push({ from: line.from, to: line.from + oldPrefixLen, insert: newPrefix })
  }
  view.dispatch({ changes })
  view.focus()
}

/**
 * Line-anchored block prefix toggle (`> `, `- `, `- [ ] `, …). Per-line
 * on multi-line selections.
 *
 * Single line:
 *   - same prefix → strip
 *   - different list-style prefix → replace
 *   - no prefix → prepend
 *
 * Multi-line:
 *   - all non-blank lines have this exact prefix → strip all
 *   - otherwise → set all (replacing any existing list-style prefix)
 *   - blank lines untouched
 *
 * For sequentially-numbered ordered lists, use `toggleOrderedList`
 * instead: it numbers each line `1.`, `2.`, `3.` rather than giving
 * every line the same prefix.
 */
export function toggleLinePrefix(view: EditorView, prefix: string): void {
  const lines = linesInPrimarySelection(view)
  const nonBlank = lines.filter(l => !isBlank(l.text))
  if (nonBlank.length === 0) return

  const wanted = prefix.replace(/^\s*/, '')
  // Checked and unchecked task items are the same list type: "task list"
  // on a checked item toggles the task off instead of normalising the
  // check state.
  const isTaskPrefix = (s: string) => /^[-*]\s+\[[ xX]\]\s+/.test(s)
  const hasPrefix = (text: string) => {
    const m = BLOCK_PREFIX_RE.exec(text)
    if (!m) return false
    if (m[2] === wanted) return true
    if (m[2] !== undefined && isTaskPrefix(m[2]) && isTaskPrefix(wanted)) return true
    return false
  }
  const allHavePrefix = nonBlank.every(l => hasPrefix(l.text))

  const changes: ChangeSpec[] = []
  for (const line of nonBlank) {
    const m = BLOCK_PREFIX_RE.exec(line.text)
    const indent = m ? m[1] : ''
    const oldPrefixLen = (m ? m[0].length : 0)
    const newPrefix = allHavePrefix ? '' : prefix
    changes.push({
      from: line.from,
      to: line.from + oldPrefixLen,
      insert: indent + newPrefix
    })
  }
  view.dispatch({ changes })
  view.focus()
}

/**
 * Ordered-list toggle with sequential numbering on multi-line.
 *
 * Single line:
 *   - already `\d+. ` → strip
 *   - other list prefix → replace with `1. `
 *   - no prefix → prepend `1. `
 *
 * Multi-line:
 *   - all non-blank lines numbered → strip all
 *   - otherwise → number sequentially `1. `, `2. `, `3. `, …
 *   - blank lines untouched (and don't increment the counter)
 */
export function toggleOrderedList(view: EditorView): void {
  const lines = linesInPrimarySelection(view)
  const nonBlank = lines.filter(l => !isBlank(l.text))
  if (nonBlank.length === 0) return

  const numbered = (text: string) => /^\s*\d+\.\s+/.test(text)
  const allNumbered = nonBlank.every(l => numbered(l.text))

  const changes: ChangeSpec[] = []
  let counter = 1
  for (const line of nonBlank) {
    const m = BLOCK_PREFIX_RE.exec(line.text)
    const indent = m ? m[1] : ''
    const oldPrefixLen = (m ? m[0].length : 0)
    const newPrefix = allNumbered ? '' : `${counter}. `
    changes.push({
      from: line.from,
      to: line.from + oldPrefixLen,
      insert: indent + newPrefix
    })
    if (!allNumbered) counter++
  }
  view.dispatch({ changes })
  view.focus()
}

/**
 * Insert a markdown table sized `rows × cols`. `rows` includes the header
 * row, so a "3 × 3" pick yields three visible rows. The header gets
 * `Column 1` … `Column N` placeholders; body cells are three spaces so the
 * source reads cleanly.
 *
 * Always inserts on its own pair of newlines so the table parses wherever
 * the cursor was.
 */
export function insertTable(view: EditorView, rows: number, cols: number): void {
  const safeRows = Math.max(1, rows)
  const safeCols = Math.max(1, cols)
  const headerCells = Array.from({ length: safeCols }, (_, i) => `Column ${i + 1}`)
  const separator = Array.from({ length: safeCols }, () => '---')
  const emptyCells = Array.from({ length: safeCols }, () => '   ')
  const bodyRows = Math.max(0, safeRows - 1)
  const lines = [
    `| ${headerCells.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...Array.from({ length: bodyRows }, () => `| ${emptyCells.join(' | ')} |`)
  ]
  const block = '\n' + lines.join('\n') + '\n'
  const { from, to } = view.state.selection.main
  view.dispatch({
    changes: { from, to, insert: block },
    selection: { anchor: from + block.length }
  })
  view.focus()
}

/**
 * Replace the current selection with a block of text (HRs, tables). A
 * plain insertion: no toggle, not per-line.
 */
export function insertBlock(view: EditorView, text: string): void {
  const { from, to } = view.state.selection.main
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length }
  })
  view.focus()
}

/**
 * The text that puts an image (or any Markdown block) at a cursor between
 * `before` and `after` as its own paragraph: a blank line on either side
 * unless one is already there, nothing extra at the start or end of the
 * document.
 */
function blockAtCursor(before: string, after: string, block: string): string {
  let prefix = '\n\n'
  if (before === '' || before.endsWith('\n\n')) prefix = ''
  else if (before.endsWith('\n')) prefix = '\n'
  let suffix = '\n\n'
  if (after === '') suffix = '\n'
  else if (after.startsWith('\n\n')) suffix = ''
  else if (after.startsWith('\n')) suffix = '\n'
  return prefix + block + suffix
}

/** Insert a Markdown block (an image reference) at the cursor as its own paragraph; the cursor ends after it. */
export function insertBlockAtCursor(view: EditorView, block: string): void {
  const { from, to } = view.state.selection.main
  const text = blockAtCursor(view.state.sliceDoc(0, from), view.state.sliceDoc(to), block)
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length }
  })
  view.focus()
}

function footnoteSeparator(lastChar: string): string {
  return lastChar === '\n' ? '\n' : '\n\n'
}

/**
 * Insert a footnote pair: the `[^N]` ref at the cursor and a matching
 * `[^N]: ` definition at the end of the doc, with the cursor at the empty
 * definition body.
 *
 * `N` is the next integer after the highest existing `[^digit]` ref, so
 * three footnotes in a row give 1, 2, 3 wherever they sit in the body.
 */
export function insertFootnote(view: EditorView): void {
  const docText = view.state.doc.toString()
  const refs = [...docText.matchAll(/\[\^(\d+)\]/g)].map(m => Number.parseInt(m[1] ?? '0', 10))
  const next = refs.length > 0 ? Math.max(...refs) + 1 : 1
  const ref = `[^${next}]`

  const { from, to } = view.state.selection.main
  const docLen = view.state.doc.length

  // The definition must land in its own paragraph at the bottom.
  const lastChar = docLen > 0 ? view.state.sliceDoc(docLen - 1, docLen) : ''
  const sep = docLen === 0 ? '' : footnoteSeparator(lastChar)
  const def = `${sep}[^${next}]: `

  view.dispatch({
    changes: [
      { from, to, insert: ref },
      { from: docLen, insert: def }
    ],
    // End of the empty definition body, after both changes.
    selection: { anchor: docLen + ref.length + def.length }
  })
  view.focus()
}

export type AlertKind = 'NOTE' | 'TIP' | 'IMPORTANT' | 'WARNING' | 'CAUTION'

/**
 * Insert a GitHub-style alert block (rendered to `.markdown-alert` by
 * `@mdit/plugin-alert`). The selection, if any, becomes the body;
 * otherwise a placeholder line is inserted.
 *
 * Every body line is prefixed with `> `: the plugin parses the alert as a
 * single blockquote.
 */
export function insertAlert(view: EditorView, kind: AlertKind): void {
  const { from, to } = view.state.selection.main
  const selected = view.state.sliceDoc(from, to)
  const bodyText = selected || ''
  const bodyLines = bodyText.length > 0
    ? bodyText.split('\n').map(l => `> ${l}`).join('\n')
    : '> '
  const block = `> [!${kind}]\n${bodyLines}`
  view.dispatch({
    changes: { from, to, insert: block },
    // End of the body.
    selection: { anchor: from + block.length }
  })
  view.focus()
}

/**
 * Insert KaTeX math at the current selection. Inline wraps the selection
 * in `$…$`; block emits a `$$…$$` display equation on its own lines. An
 * empty selection puts the cursor between the delimiters.
 */
export function insertMath(view: EditorView, mode: 'inline' | 'block'): void {
  const { from, to } = view.state.selection.main
  const selected = view.state.sliceDoc(from, to)

  if (mode === 'inline') {
    const body = selected || ''
    const block = `$${body}$`
    view.dispatch({
      changes: { from, to, insert: block },
      selection: body.length > 0
        ? { anchor: from + 1, head: from + 1 + body.length }
        : { anchor: from + 1 }
    })
    view.focus()
    return
  }

  // The parser needs the delimiters on their own lines.
  const body = selected || ''
  const block = `$$\n${body}\n$$`
  const cursor = body.length > 0
    ? from + 3 + body.length // end of body
    : from + 3 // empty body, cursor between fences
  view.dispatch({
    changes: { from, to, insert: block },
    selection: { anchor: cursor }
  })
  view.focus()
}

export type MermaidKind
  = | 'flowchart'
    | 'sequence'
    | 'class'
    | 'state'
    | 'er'
    | 'gantt'
    | 'pie'
    | 'mindmap'

/**
 * Minimal runnable example per Mermaid diagram kind, short enough to edit
 * in place; a rendered preview appears immediately.
 */
const MERMAID_TEMPLATES: Record<MermaidKind, string> = {
  flowchart: `flowchart LR
  A[Start] --> B{Decision}
  B -->|Yes| C[Done]
  B -->|No| D[Retry]`,
  sequence: `sequenceDiagram
  Alice->>Bob: Hello Bob
  Bob-->>Alice: Hi Alice`,
  class: `classDiagram
  class Animal {
    +String name
    +eat()
  }
  Animal <|-- Dog`,
  state: `stateDiagram-v2
  [*] --> Active
  Active --> Inactive : pause
  Inactive --> Active : resume
  Active --> [*]`,
  er: `erDiagram
  CUSTOMER ||--o{ ORDER : places
  ORDER ||--|{ LINE_ITEM : contains`,
  gantt: `gantt
  title Project Plan
  dateFormat YYYY-MM-DD
  section Plan
  Design :a1, 2026-01-01, 14d
  Build  :after a1, 21d`,
  pie: `pie title Distribution
  "Apples" : 40
  "Pears" : 35
  "Oranges" : 25`,
  mindmap: `mindmap
  root((Idea))
    Branch 1
      Leaf
    Branch 2`
}

/**
 * Insert a ` ```mermaid ` block with an example for the chosen diagram
 * kind; the iframe pre-processor (preview + print) renders it before
 * paged.js paginates.
 *
 * Always inserts on its own pair of newlines so the fence parses wherever
 * the cursor was.
 */
export function insertDiagram(view: EditorView, kind: MermaidKind): void {
  const { from, to } = view.state.selection.main
  const template = MERMAID_TEMPLATES[kind]
  const block = `\n\`\`\`mermaid\n${template}\n\`\`\`\n`
  view.dispatch({
    changes: { from, to, insert: block },
    // End of the inserted block, ready for prose after the diagram.
    selection: { anchor: from + block.length }
  })
  view.focus()
}

/**
 * Insert a `<!-- pagebreak -->` marker, which the renderer turns into
 * `<div class="page-break">` for paged.js. As an HTML comment it is
 * invisible in other markdown renderers.
 */
export function insertPageBreak(view: EditorView): void {
  const { from, to } = view.state.selection.main
  const block = '\n<!-- pagebreak -->\n'
  view.dispatch({
    changes: { from, to, insert: block },
    selection: { anchor: from + block.length }
  })
  view.focus()
}

/**
 * Wrap (or unwrap) the current selection in `<!-- ... -->`. Comments stay
 * in the source but the comment plugin in `renderMarkdown.ts` strips them
 * from preview/PDF/share (private notes, alternative phrasings).
 *
 *   - Empty selection: inserts `<!--  -->` with the cursor between the
 *     spaces.
 *   - Selection already starts with `<!--` and ends with `-->`: unwraps,
 *     keeping the inner text.
 *   - Otherwise: wraps as `<!-- selected -->` (single or multi-line).
 */
export function toggleComment(view: EditorView): void {
  const { from, to } = view.state.selection.main
  const selected = view.state.sliceDoc(from, to)

  if (selected.length === 0) {
    const insert = '<!--  -->'
    view.dispatch({
      changes: { from, to, insert },
      // Between the two spaces inside the delimiters.
      selection: { anchor: from + 5 }
    })
    view.focus()
    return
  }

  const trimmed = selected.trim()
  if (trimmed.startsWith('<!--') && trimmed.endsWith('-->') && trimmed.length >= 7) {
    // Only the trimmed core is touched, preserving surrounding whitespace.
    const lead = leadingWhitespace(selected)
    const trail = selected.slice(selected.trimEnd().length)
    const inner = trimmed.slice(4, -3).trim()
    const insert = lead + inner + trail
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from, head: from + insert.length }
    })
    view.focus()
    return
  }

  const insert = `<!-- ${selected} -->`
  view.dispatch({
    changes: { from, to, insert },
    // Re-select the text so a second click toggles back.
    selection: { anchor: from + 5, head: from + 5 + selected.length }
  })
  view.focus()
}

/**
 * Insert a `[[toc]]` placeholder, which markdown-it-toc-done-right
 * rewrites into a nested list of heading links. It goes on its own line so
 * it parses as a block token, not inline text.
 */
export function insertToc(view: EditorView): void {
  const { from, to } = view.state.selection.main
  const block = '\n[[toc]]\n'
  view.dispatch({
    changes: { from, to, insert: block },
    selection: { anchor: from + block.length }
  })
  view.focus()
}

/**
 * Insert a `[[bibliography]]` / `[[lof]]` / `[[lot]]` placeholder on a
 * line of its own (the renderer fills it: citationResolve.ts).
 */
export function insertListPlaceholder(view: EditorView, kind: 'bibliography' | 'lof' | 'lot'): void {
  const { from, to } = view.state.selection.main
  const block = `\n[[${kind}]]\n`
  view.dispatch({
    changes: { from, to, insert: block },
    selection: { anchor: from + block.length }
  })
  view.focus()
}

/** Replace the selection with `text` (a citation from the References panel) and put the caret after it. */
export function insertInline(view: EditorView, text: string): void {
  const { from, to } = view.state.selection.main
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length }
  })
  view.focus()
}

/**
 * Insert a definition-list template (`Term\n: Definition`) and select
 * "Term" so typing replaces it.
 */
export function insertDefinitionList(view: EditorView): void {
  const { from, to } = view.state.selection.main
  const template = 'Term\n: Definition'
  view.dispatch({
    changes: { from, to, insert: template },
    selection: { anchor: from, head: from + 4 }
  })
  view.focus()
}

/**
 * Inline-formatting shortcuts advertised by the Format menu (Bold, Italic).
 * `Mod` is Cmd on macOS and Ctrl elsewhere. Read-only editors return false
 * so the browser's own handling is untouched.
 */
function wrapCommand(marker: string): (view: EditorView) => boolean {
  return (view) => {
    if (view.state.readOnly) return false
    toggleWrap(view, marker)
    return true
  }
}

export const formattingKeymap: readonly KeyBinding[] = [
  { key: 'Mod-b', run: wrapCommand('**'), preventDefault: true },
  { key: 'Mod-i', run: wrapCommand('*'), preventDefault: true }
]
