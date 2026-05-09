import type { EditorView } from '@codemirror/view'
import type { ChangeSpec } from '@codemirror/state'

/**
 * Editor command helpers for the formatting toolbar + menu bar.
 *
 * Design rules (apply to every helper):
 *
 *  1. **Idempotent.** Clicking the same action twice on the same
 *     selection always toggles. Never accumulates markers
 *     (`****foo****`) or stacks prefixes (`# ## Foo`).
 *
 *  2. **Whitespace-safe.** Wrapping a selection like `  foo  ` puts
 *     the markers OUTSIDE the trimmed range so the result is
 *     `  **foo**  `, which is valid markdown. Whitespace-only
 *     selections behave like empty (drop a marker pair, cursor inside).
 *
 *  3. **Per-line for line-anchored ops.** Headings, lists, quotes
 *     apply to every non-blank line in the selection — clicking H1
 *     across three lines makes all three H1. Blank lines are skipped
 *     (we don't add `# ` to an empty line).
 *
 *  4. **Per-line for inline wraps when multi-line.** If the selection
 *     spans more than one line, each non-blank line gets the marker
 *     individually. Otherwise the existing wrap goes outside the
 *     trimmed selection.
 *
 *  5. **Mixed-state toggle policy.** When a multi-line action would
 *     have an asymmetric effect (some lines already have the
 *     marker/prefix, some don't), we **add** to all missing rather
 *     than removing from all present. So a single click is always
 *     either "make all this X" or "remove X from all this", never
 *     partial. Toggle off only fires when ALL non-blank lines already
 *     have the marker/prefix.
 *
 *  6. **Disambiguation.** Single-char markers (`*` italic, `~` sub)
 *     never steal from doubled markers (`**` bold, `~~` strike). So
 *     italic on `**foo**` produces `***foo***`, not `*foo*` corruption.
 *
 *  7. **Code is special.** `toggleCode` produces inline backticks for
 *     single-line selections, a fenced ` ``` ` block for multi-line.
 */

// — line walking ——————————————————————————————————————————————————

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

// — inline wrap (single-line core) —————————————————————————————————

/**
 * Wrap/unwrap one selection range with `marker`. Used directly for
 * single-line ops; the multi-line `toggleWrap` calls into this per
 * line. Builds and returns a ChangeSpec list rather than dispatching
 * so callers can batch.
 */
function wrapRangeChanges(
  view: EditorView,
  from: number,
  to: number,
  marker: string
): { changes: ChangeSpec[], finalFrom: number, finalTo: number } | null {
  const docLen = view.state.doc.length
  const selected = view.state.sliceDoc(from, to)
  const leading = /^\s*/.exec(selected)![0]
  const trailing = /\s*$/.exec(selected)![0]
  const trimmed = selected.slice(leading.length, selected.length - trailing.length)

  // Empty / whitespace-only — caller decides if it makes sense to act.
  if (trimmed.length === 0) {
    if (from === to) {
      // Empty cursor — drop marker pair, cursor between.
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

  // Outside-wrap: marker chars adjacent to the trimmed range.
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

  // Inside-wrap: trimmed text starts AND ends with marker (selection
  // dragged across the wrappers).
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

  // Default: wrap outside the trimmed range.
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

  // Single-line path (or empty selection).
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

  // Multi-line path — per non-blank line.
  const lines = linesInPrimarySelection(view)
  const nonBlank = lines.filter(l => !isBlank(l.text))
  if (nonBlank.length === 0) return

  const wrappedTrimmed = (text: string) => {
    const trimmed = text.trim()
    if (trimmed.length < marker.length * 2) return false
    if (!trimmed.startsWith(marker) || !trimmed.endsWith(marker)) return false
    if (marker.length === 1 && (marker === '*' || marker === '~')) {
      // Defensive: don't treat `**foo**` as italic-wrapped.
      if (trimmed[marker.length] === marker
        || trimmed[trimmed.length - marker.length - 1] === marker) return false
    }
    return true
  }

  const allWrapped = nonBlank.every(l => wrappedTrimmed(l.text))
  const changes: ChangeSpec[] = []

  for (const line of nonBlank) {
    const text = line.text
    const leading = /^\s*/.exec(text)![0]
    const trailing = /\s*$/.exec(text)![0]
    const trimmed = text.slice(leading.length, text.length - trailing.length)

    if (allWrapped) {
      // Strip wrap on every line.
      const stripped = trimmed.slice(marker.length, trimmed.length - marker.length)
      changes.push({ from: line.from, to: line.to, insert: leading + stripped + trailing })
    } else {
      // Add wrap only to lines that don't already have it (idempotent).
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

// — code (special) ————————————————————————————————————————————————

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

  // Case A: selection includes the fence lines themselves (user selected
  // the whole block).
  if (fenceOpen.test(startLine.text) && fenceClose.test(endLine.text) && startLine.number < endLine.number) {
    // Strip the first and last line of the selection (the fences) plus
    // the newline that follows / precedes them.
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

  // Case B: selection is between fence lines (above startLine and below endLine).
  const lineBefore = startLine.number > 1 ? view.state.doc.line(startLine.number - 1) : null
  const lineAfter = endLine.number < view.state.doc.lines ? view.state.doc.line(endLine.number + 1) : null
  const fenceBefore = lineBefore && fenceOpen.test(lineBefore.text)
  const fenceAfter = lineAfter && fenceClose.test(lineAfter.text)

  if (fenceBefore && fenceAfter) {
    view.dispatch({
      changes: [
        { from: lineBefore!.from, to: startLine.from, insert: '' },
        { from: endLine.to, to: lineAfter!.to, insert: '' }
      ]
    })
    view.focus()
    return
  }

  // Default: wrap.
  view.dispatch({
    changes: [
      { from: startLine.from, insert: '```\n' },
      { from: endLine.to, insert: '\n```' }
    ]
  })
  view.focus()
}

// — heading prefix —————————————————————————————————————————————————

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
    const m = text.match(HEADING_PREFIX_RE)
    return !!m && m[1]!.length === level
  }
  const allAtLevel = nonBlank.every(l => atLevel(l.text))

  const changes: ChangeSpec[] = []
  for (const line of nonBlank) {
    const m = line.text.match(HEADING_PREFIX_RE)
    const oldPrefixLen = m ? m[0].length : 0
    const newPrefix = allAtLevel ? '' : '#'.repeat(level) + ' '
    changes.push({ from: line.from, to: line.from + oldPrefixLen, insert: newPrefix })
  }
  view.dispatch({ changes })
  view.focus()
}

// — line prefix (quote, unordered list, task list) ————————————————————

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
 * instead — it numbers each line `1.`, `2.`, `3.` rather than giving
 * every line the same prefix.
 */
export function toggleLinePrefix(view: EditorView, prefix: string): void {
  const lines = linesInPrimarySelection(view)
  const nonBlank = lines.filter(l => !isBlank(l.text))
  if (nonBlank.length === 0) return

  const wanted = prefix.replace(/^\s*/, '')
  // Checked (`- [x] `) and unchecked (`- [ ] `) task items are the same
  // list type — clicking "task list" on a checked item should toggle
  // the whole task off, not normalize the check state.
  const isTaskPrefix = (s: string) => /^[-*]\s+\[[ xX]\]\s+/.test(s)
  const hasPrefix = (text: string) => {
    const m = text.match(BLOCK_PREFIX_RE)
    if (!m) return false
    if (m[2] === wanted) return true
    if (isTaskPrefix(m[2]!) && isTaskPrefix(wanted)) return true
    return false
  }
  const allHavePrefix = nonBlank.every(l => hasPrefix(l.text))

  const changes: ChangeSpec[] = []
  for (const line of nonBlank) {
    const m = line.text.match(BLOCK_PREFIX_RE)
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
    const m = line.text.match(BLOCK_PREFIX_RE)
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

// — block insert ——————————————————————————————————————————————————

/**
 * Insert a markdown table sized `rows × cols` (rows includes the header
 * row, matching the convention users expect from picker-style table
 * inserters: a "3 × 3" pick yields three visible rows total). The first
 * row gets `Column 1` … `Column N` placeholders; body cells are blank
 * (three spaces per cell so the table reads cleanly in source).
 *
 * Always inserts on its own pair of newlines so the table parses
 * cleanly regardless of where the cursor was.
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
 * Replace the current selection with a block of text. Used for HRs and
 * tables. No toggle, no per-line — just an insertion.
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
 * Insert a footnote pair: the `[^N]` ref at the cursor and a matching
 * `[^N]: ` definition at the end of the doc, with the cursor placed at
 * the empty definition body so the user can type immediately.
 *
 * `N` is auto-numbered: scans existing `[^digit]` refs and picks the
 * next integer. So adding three footnotes in a row produces 1, 2, 3
 * regardless of where they're inserted in the doc body.
 */
export function insertFootnote(view: EditorView): void {
  const docText = view.state.doc.toString()
  const refs = [...docText.matchAll(/\[\^(\d+)\]/g)].map(m => Number.parseInt(m[1]!, 10))
  const next = refs.length > 0 ? Math.max(...refs) + 1 : 1
  const ref = `[^${next}]`

  const { from, to } = view.state.selection.main
  const docLen = view.state.doc.length

  // Make sure the definition lands on its own line. If the doc is empty
  // or already ends with a newline, just append; otherwise prefix with
  // `\n\n` so it sits in its own paragraph at the bottom.
  const lastChar = docLen > 0 ? view.state.sliceDoc(docLen - 1, docLen) : ''
  const sep = docLen === 0 ? '' : (lastChar === '\n' ? '\n' : '\n\n')
  const def = `${sep}[^${next}]: `

  view.dispatch({
    changes: [
      { from, to, insert: ref },
      { from: docLen, insert: def }
    ],
    // Cursor at the end of the empty definition body (post-both-changes).
    selection: { anchor: docLen + ref.length + def.length }
  })
  view.focus()
}

export type AlertKind = 'NOTE' | 'TIP' | 'IMPORTANT' | 'WARNING' | 'CAUTION'

/**
 * Insert a GitHub-style alert block at the current selection. Renders to
 * a `.markdown-alert` div via `@mdit/plugin-alert`. The selection (if
 * any) becomes the body; otherwise inserts a placeholder line and lands
 * the cursor where the user can immediately type.
 *
 * Each line of the body is prefixed with `> ` so the alert reads as a
 * single blockquote — that's the syntax the plugin parses.
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
    // Cursor at end of body for continued typing.
    selection: { anchor: from + block.length }
  })
  view.focus()
}

/**
 * Insert KaTeX math at the current selection. Inline wraps the selection
 * in single `$…$`; block emits a `$$…$$` fenced display equation on its
 * own line(s). Empty selection drops the cursor between the delimiters
 * so the user can type the formula immediately.
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

  // Block: ensure delimiters sit on their own lines for the parser.
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
 * Minimal working examples for each Mermaid diagram kind. Each snippet
 * is short enough that the user can edit-in-place rather than read a
 * tutorial first. Kept as runnable diagrams (not skeletal placeholders)
 * so a user clicking "Sequence" gets an immediately-rendered preview to
 * play with.
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
  section Phase 1
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
 * Insert a Mermaid code block with a minimal example for the chosen
 * diagram kind. The block is fenced as ` ```mermaid `; the iframe
 * pre-processor (preview + print) detects the language and replaces
 * the block with its rendered SVG before paged.js paginates.
 *
 * Always inserts on its own pair of newlines so the fence parses
 * cleanly regardless of where the cursor was.
 */
export function insertDiagram(view: EditorView, kind: MermaidKind): void {
  const { from, to } = view.state.selection.main
  const template = MERMAID_TEMPLATES[kind]
  const block = `\n\`\`\`mermaid\n${template}\n\`\`\`\n`
  view.dispatch({
    changes: { from, to, insert: block },
    // Cursor at the end of the inserted block, ready to add prose
    // after the diagram. The user can click into the diagram source
    // to edit it.
    selection: { anchor: from + block.length }
  })
  view.focus()
}

/**
 * Insert a `<!-- pagebreak -->` marker. The renderer's custom block
 * rule turns it into `<div class="page-break">`, which paged.js
 * breaks on. HTML-comment syntax means the marker is invisible in
 * other markdown renderers — docs ported elsewhere keep working.
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
 * Wrap (or unwrap) the current selection in `<!-- ... -->`. Comments
 * stay in the markdown source but are stripped from preview/PDF/share
 * by the comment plugin in `renderMarkdown.ts` — useful for private
 * todos, alternative phrasings, and reminders to the writer.
 *
 * Behavior matches the bold-style `toggleWrap` ergonomics:
 *   - Empty selection → inserts `<!--  -->` and lands the cursor
 *     between the spaces, ready to type.
 *   - Selection already starts with `<!--` and ends with `-->` →
 *     unwraps (strips the delimiters), preserving the inner text.
 *   - Otherwise → wraps the selection as `<!-- selected -->` (single
 *     line or multi-line; the renderer handles both forms).
 */
export function toggleComment(view: EditorView): void {
  const { from, to } = view.state.selection.main
  const selected = view.state.sliceDoc(from, to)

  if (selected.length === 0) {
    const insert = '<!--  -->'
    view.dispatch({
      changes: { from, to, insert },
      // Cursor between the two spaces inside the delimiters.
      selection: { anchor: from + 5 }
    })
    view.focus()
    return
  }

  const trimmed = selected.trim()
  if (trimmed.startsWith('<!--') && trimmed.endsWith('-->') && trimmed.length >= 7) {
    // Unwrap. Preserve original leading/trailing whitespace by only
    // touching the trimmed core.
    const lead = /^\s*/.exec(selected)![0]
    const trail = /\s*$/.exec(selected)![0]
    const inner = trimmed.slice(4, trimmed.length - 3).replace(/^\s+|\s+$/g, '')
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
    // Re-select the original text inside the new delimiters so a second
    // click toggles cleanly.
    selection: { anchor: from + 5, head: from + 5 + selected.length }
  })
  view.focus()
}

/**
 * Insert a `[[toc]]` placeholder. The renderer (markdown-it-toc-done-
 * right) rewrites it into a nested list of links to every heading in
 * the doc. Always lands on its own line so the placeholder parses as
 * a block-level token, not inline text.
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
 * Insert a definition-list template (`Term\n: Definition`) at the
 * cursor. Selects "Term" so the user can immediately type a real term;
 * the definition placeholder gets typed-into next via Tab/click.
 */
export function insertDefinitionList(view: EditorView): void {
  const { from, to } = view.state.selection.main
  const template = 'Term\n: Definition'
  view.dispatch({
    changes: { from, to, insert: template },
    // Pre-select "Term" (4 chars) so typing replaces it.
    selection: { anchor: from, head: from + 4 }
  })
  view.focus()
}
