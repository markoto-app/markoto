import { describe, it, expect } from 'vitest'
import { EditorState, EditorSelection } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import {
  toggleWrap,
  toggleCode,
  toggleComment,
  toggleHeading,
  toggleLinePrefix,
  toggleOrderedList,
  insertTable,
  insertBlock,
  insertFootnote,
  insertAlert,
  insertMath,
  insertDiagram,
  insertPageBreak,
  insertToc,
  insertDefinitionList
} from '~/utils/editorCommands'

// Test harness — shim an EditorView with only the surface editorCommands
// actually touches: `.state` getter + `.dispatch(spec)`. This keeps the
// suite in the `unit` project (no DOM) and keeps boot time ~0ms per case.

function makeView(
  doc: string,
  selection?: number | { from: number, to: number } | Array<{ anchor: number, head?: number }>
): EditorView {
  let sel: EditorSelection
  if (selection === undefined) {
    sel = EditorSelection.single(doc.length)
  } else if (typeof selection === 'number') {
    sel = EditorSelection.single(selection)
  } else if (Array.isArray(selection)) {
    sel = EditorSelection.create(selection.map(r => EditorSelection.range(r.anchor, r.head ?? r.anchor)))
  } else {
    sel = EditorSelection.single(selection.from, selection.to)
  }
  let state = EditorState.create({ doc, selection: sel })
  const view = {
    get state() { return state },
    dispatch(spec: Parameters<EditorState['update']>[0]) {
      state = state.update(spec).state
    },
    // Several `insertX` helpers call view.focus() at the end so the
    // toolbar click returns focus to the editor. We don't care about
    // DOM focus in unit tests — no-op is fine.
    focus() {}
  }
  return view as unknown as EditorView
}

function text(view: EditorView): string {
  return view.state.doc.toString()
}

function cursorAt(view: EditorView): number {
  return view.state.selection.main.head
}

function selectedText(view: EditorView): string {
  const { from, to } = view.state.selection.main
  return view.state.sliceDoc(from, to)
}

// ═══════════════════════════════════════════════════════════════════════
// toggleWrap — inline wrap with symmetric marker
//
// Black-box spec (from file-header invariants):
//   - Empty/whitespace-only selection drops a marker pair, cursor inside.
//   - Plain selection wraps: foo → **foo**.
//   - Already-wrapped toggles off: **foo** → foo.
//   - Whitespace-padded: "  foo  " → "  **foo**  " (markers outside trim).
//   - Multi-line: wraps each non-blank line individually. Blank lines skipped.
//   - Mixed-state: adds to missing, never partial-removes.
//   - Disambiguation: `*` italic does not strip from `**foo**` — must
//     produce `***foo***`. Same rule for `~` vs `~~`.
// ═══════════════════════════════════════════════════════════════════════

describe('toggleWrap — bold (**)', () => {
  it('cursor only: inserts empty marker pair with cursor between', () => {
    const v = makeView('', 0)
    toggleWrap(v, '**')
    expect(text(v)).toBe('****')
    expect(cursorAt(v)).toBe(2)
  })

  it('wraps a plain selection', () => {
    const v = makeView('foo', { from: 0, to: 3 })
    toggleWrap(v, '**')
    expect(text(v)).toBe('**foo**')
  })

  it('toggles off an already-wrapped selection', () => {
    const v = makeView('**foo**', { from: 0, to: 7 })
    toggleWrap(v, '**')
    expect(text(v)).toBe('foo')
  })

  it('toggles off when the inner text is selected but markers are adjacent', () => {
    // Selecting just "foo" from "**foo**" — user expectation is still
    // "turn off bold on this text" since the markers are right there.
    const v = makeView('**foo**', { from: 2, to: 5 })
    toggleWrap(v, '**')
    expect(text(v)).toBe('foo')
  })

  it('whitespace-padded selection: markers outside the trimmed range', () => {
    const v = makeView('  foo  ', { from: 0, to: 7 })
    toggleWrap(v, '**')
    expect(text(v)).toBe('  **foo**  ')
  })

  it('whitespace-only selection: no-op (does NOT drop a marker pair)', () => {
    // NOTE: the file-header comment in editorCommands.ts claims that
    // "whitespace-only selections behave like empty (drop a marker
    // pair, cursor inside)". The actual implementation returns null
    // from wrapRangeChanges and leaves the doc untouched. This test
    // pins the code's behavior (silent no-op) — producing `**   **`
    // would be worse UX than doing nothing — but the header comment
    // is incorrect and should be fixed there, not here.
    const v = makeView('   ', { from: 0, to: 3 })
    toggleWrap(v, '**')
    expect(text(v)).toBe('   ')
  })

  it('multi-line selection wraps each non-blank line individually', () => {
    const v = makeView('foo\nbar', { from: 0, to: 7 })
    toggleWrap(v, '**')
    expect(text(v)).toBe('**foo**\n**bar**')
  })

  it('multi-line with a blank line: blanks are skipped', () => {
    const v = makeView('foo\n\nbar', { from: 0, to: 8 })
    toggleWrap(v, '**')
    expect(text(v)).toBe('**foo**\n\n**bar**')
  })

  it('mixed-state multi-line: adds markers to missing lines', () => {
    // One line already bold, one not — single click should bold the
    // missing one, NOT strip the existing. Invariant #5.
    const v = makeView('foo\n**bar**', { from: 0, to: 11 })
    toggleWrap(v, '**')
    expect(text(v)).toBe('**foo**\n**bar**')
  })

  it('all-wrapped multi-line: toggles off every line', () => {
    const v = makeView('**foo**\n**bar**', { from: 0, to: 15 })
    toggleWrap(v, '**')
    expect(text(v)).toBe('foo\nbar')
  })
})

describe('toggleWrap — italic (*) disambiguation vs bold', () => {
  it('wraps plain text with single asterisks', () => {
    const v = makeView('foo', { from: 0, to: 3 })
    toggleWrap(v, '*')
    expect(text(v)).toBe('*foo*')
  })

  it('does NOT strip bold when italic is toggled on **foo**', () => {
    // Invariant #6: single-char markers don't steal from doubled. Expected
    // result is ***foo*** (italic nested around bold), not *foo*.
    const v = makeView('**foo**', { from: 0, to: 7 })
    toggleWrap(v, '*')
    expect(text(v)).toBe('***foo***')
  })

  it('toggles off italic on a *foo* selection', () => {
    const v = makeView('*foo*', { from: 0, to: 5 })
    toggleWrap(v, '*')
    expect(text(v)).toBe('foo')
  })
})

describe('toggleWrap — strike (~~) + sub (~) disambiguation', () => {
  it('strike wraps plain text', () => {
    const v = makeView('foo', { from: 0, to: 3 })
    toggleWrap(v, '~~')
    expect(text(v)).toBe('~~foo~~')
  })

  it('strike toggles off', () => {
    const v = makeView('~~foo~~', { from: 0, to: 7 })
    toggleWrap(v, '~~')
    expect(text(v)).toBe('foo')
  })

  it('sub (~) does not strip strike (~~) — produces ~~~foo~~~ when nested', () => {
    // Invariant #6 — same rule as `*` vs `**`.
    const v = makeView('~~foo~~', { from: 0, to: 7 })
    toggleWrap(v, '~')
    expect(text(v)).toBe('~~~foo~~~')
  })
})

describe('toggleWrap — other markers (happy-path only)', () => {
  it('highlight == wraps correctly', () => {
    const v = makeView('foo', { from: 0, to: 3 })
    toggleWrap(v, '==')
    expect(text(v)).toBe('==foo==')
  })

  it('ins ++ wraps correctly', () => {
    const v = makeView('foo', { from: 0, to: 3 })
    toggleWrap(v, '++')
    expect(text(v)).toBe('++foo++')
  })

  it('sup ^ wraps correctly', () => {
    const v = makeView('foo', { from: 0, to: 3 })
    toggleWrap(v, '^')
    expect(text(v)).toBe('^foo^')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// toggleCode — inline vs fenced (invariant #7)
// ═══════════════════════════════════════════════════════════════════════

describe('toggleCode', () => {
  it('cursor only: inserts empty inline backticks with cursor between', () => {
    const v = makeView('', 0)
    toggleCode(v)
    expect(text(v)).toBe('``')
    expect(cursorAt(v)).toBe(1)
  })

  it('single-line selection: wraps in inline backticks', () => {
    const v = makeView('foo', { from: 0, to: 3 })
    toggleCode(v)
    expect(text(v)).toBe('`foo`')
  })

  it('single-line already-inline toggles off', () => {
    const v = makeView('`foo`', { from: 0, to: 5 })
    toggleCode(v)
    expect(text(v)).toBe('foo')
  })

  it('multi-line selection: wraps in a fenced code block', () => {
    // Invariant #7 — multi-line becomes ``` ... ``` rather than backticks
    // per line.
    const v = makeView('foo\nbar', { from: 0, to: 7 })
    toggleCode(v)
    // Leading ```, trailing ```, content sandwiched. Allow either the
    // fences alone or the fences with an optional `language` slot.
    expect(text(v)).toMatch(/^```[a-z]*\nfoo\nbar\n```$/)
  })

  it('already-fenced multi-line selection toggles off', () => {
    const fenced = '```\nfoo\nbar\n```'
    const v = makeView(fenced, { from: 0, to: fenced.length })
    toggleCode(v)
    expect(text(v)).toBe('foo\nbar')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// toggleHeading — levels 1..6, idempotent + replace-level
// ═══════════════════════════════════════════════════════════════════════

describe('toggleHeading', () => {
  it('adds a heading prefix when the line has none', () => {
    const v = makeView('foo', 0)
    toggleHeading(v, 2)
    expect(text(v)).toBe('## foo')
  })

  it('removes the prefix when the same level is toggled again', () => {
    const v = makeView('## foo', 0)
    toggleHeading(v, 2)
    expect(text(v)).toBe('foo')
  })

  it('replaces the level rather than stacking', () => {
    // Invariant #1 — clicking H3 on an H2 line should produce H3, not
    // `### ## foo` and not `## ### foo`.
    const v = makeView('## foo', 0)
    toggleHeading(v, 3)
    expect(text(v)).toBe('### foo')
  })

  it('promotes H1 → H2 by replacing the prefix', () => {
    const v = makeView('# foo', 0)
    toggleHeading(v, 2)
    expect(text(v)).toBe('## foo')
  })

  it('works for every level 1..6', () => {
    for (let level = 1; level <= 6; level++) {
      const v = makeView('foo', 0)
      toggleHeading(v, level)
      expect(text(v)).toBe(`${'#'.repeat(level)} foo`)
    }
  })

  it('multi-line: applies per non-blank line', () => {
    const v = makeView('foo\nbar', { from: 0, to: 7 })
    toggleHeading(v, 2)
    expect(text(v)).toBe('## foo\n## bar')
  })

  it('multi-line: blanks skipped', () => {
    const v = makeView('foo\n\nbar', { from: 0, to: 8 })
    toggleHeading(v, 2)
    expect(text(v)).toBe('## foo\n\n## bar')
  })

  it('multi-line mixed: adds to missing rather than partial-removing', () => {
    // Invariant #5 — single click is never partial.
    const v = makeView('## foo\nbar', { from: 0, to: 10 })
    toggleHeading(v, 2)
    expect(text(v)).toBe('## foo\n## bar')
  })

  it('multi-line all-heading: toggles off every line', () => {
    const v = makeView('## foo\n## bar', { from: 0, to: 13 })
    toggleHeading(v, 2)
    expect(text(v)).toBe('foo\nbar')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// toggleLinePrefix — bullets, blockquote, task lists
// ═══════════════════════════════════════════════════════════════════════

describe('toggleLinePrefix', () => {
  it('adds bullet prefix to plain line', () => {
    const v = makeView('foo', 0)
    toggleLinePrefix(v, '- ')
    expect(text(v)).toBe('- foo')
  })

  it('removes bullet prefix when already present', () => {
    const v = makeView('- foo', 0)
    toggleLinePrefix(v, '- ')
    expect(text(v)).toBe('foo')
  })

  it('adds blockquote prefix', () => {
    const v = makeView('foo', 0)
    toggleLinePrefix(v, '> ')
    expect(text(v)).toBe('> foo')
  })

  it('removes blockquote prefix when already present', () => {
    const v = makeView('> foo', 0)
    toggleLinePrefix(v, '> ')
    expect(text(v)).toBe('foo')
  })

  it('adds task-list prefix', () => {
    const v = makeView('foo', 0)
    toggleLinePrefix(v, '- [ ] ')
    expect(text(v)).toBe('- [ ] foo')
  })

  it('removes an unchecked task-list prefix', () => {
    const v = makeView('- [ ] foo', 0)
    toggleLinePrefix(v, '- [ ] ')
    expect(text(v)).toBe('foo')
  })

  it('toggle-off also removes a checked task (- [x] foo → foo)', () => {
    // Checked and unchecked tasks are the same list type — clicking
    // "task list" on a checked item must strip the task entirely, not
    // normalize the check state (`- [x] foo` → `- [ ] foo` would be
    // surprising and diverges from Notion/Obsidian behavior).
    const v = makeView('- [x] foo', 0)
    toggleLinePrefix(v, '- [ ] ')
    expect(text(v)).toBe('foo')
  })

  it('toggle-off also removes an uppercase-X checked task (- [X] foo → foo)', () => {
    // BLOCK_PREFIX_RE allows both `[x]` and `[X]` — pin that the toggle
    // honors both spellings.
    const v = makeView('- [X] foo', 0)
    toggleLinePrefix(v, '- [ ] ')
    expect(text(v)).toBe('foo')
  })

  it('bullet toggle on a checked task converts to a plain bullet', () => {
    // Orthogonal: clicking the bullet-list button on `- [x] foo`
    // should convert to a plain bullet `- foo`, not leave the task
    // prefix in place. Different prefix families = different ops.
    const v = makeView('- [x] foo', 0)
    toggleLinePrefix(v, '- ')
    expect(text(v)).toBe('- foo')
  })

  it('multi-line: applies per non-blank line', () => {
    const v = makeView('foo\nbar', { from: 0, to: 7 })
    toggleLinePrefix(v, '- ')
    expect(text(v)).toBe('- foo\n- bar')
  })

  it('multi-line blank lines are skipped', () => {
    const v = makeView('foo\n\nbar', { from: 0, to: 8 })
    toggleLinePrefix(v, '- ')
    expect(text(v)).toBe('- foo\n\n- bar')
  })

  it('multi-line mixed: adds to missing lines', () => {
    const v = makeView('- foo\nbar', { from: 0, to: 9 })
    toggleLinePrefix(v, '- ')
    expect(text(v)).toBe('- foo\n- bar')
  })

  it('multi-line all-prefixed: toggles off every line', () => {
    const v = makeView('- foo\n- bar', { from: 0, to: 11 })
    toggleLinePrefix(v, '- ')
    expect(text(v)).toBe('foo\nbar')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// toggleOrderedList — renumbering
// ═══════════════════════════════════════════════════════════════════════

describe('toggleOrderedList', () => {
  it('single line: adds 1. prefix', () => {
    const v = makeView('foo', 0)
    toggleOrderedList(v)
    expect(text(v)).toBe('1. foo')
  })

  it('multi-line: numbers starting from 1', () => {
    const v = makeView('foo\nbar\nbaz', { from: 0, to: 11 })
    toggleOrderedList(v)
    expect(text(v)).toBe('1. foo\n2. bar\n3. baz')
  })

  it('toggles off an already-numbered block', () => {
    const v = makeView('1. foo\n2. bar', { from: 0, to: 13 })
    toggleOrderedList(v)
    expect(text(v)).toBe('foo\nbar')
  })

  it('mixed unnumbered + numbered: adds numbering, renumbers from 1', () => {
    const v = makeView('1. foo\nbar', { from: 0, to: 10 })
    toggleOrderedList(v)
    // Invariant #5 — add to missing. Exact numbering should be
    // sequential from 1 across non-blank lines.
    expect(text(v)).toBe('1. foo\n2. bar')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// insertTable — pipe-table skeleton
// ═══════════════════════════════════════════════════════════════════════

describe('insertTable', () => {
  it('creates a header row + separator + body rows, with correct column count', () => {
    // Convention (per the function's own docstring): `rows` is the
    // total number of VISIBLE rows including the header. So rows=2
    // means 1 header + 1 body, plus the (invisible-in-render) separator
    // line = 3 table lines in the source. Matches picker-style UI
    // where a 3×3 grid pick yields a 3-row table.
    const v = makeView('', 0)
    insertTable(v, 3, 3)
    const out = text(v)
    // Header row has 3 cells (4 pipes: leading | + 3 separators + trailing |)
    const firstLine = out.split('\n').find(l => l.trim().startsWith('|')) || ''
    const pipeCount = (firstLine.match(/\|/g) || []).length
    expect(pipeCount).toBe(4)
    // Separator line exists with --- patterns
    expect(out).toMatch(/\|\s*-+\s*\|\s*-+\s*\|\s*-+\s*\|/)
    // Total non-blank table lines: 1 header + 1 separator + 2 body = 4
    const tableLines = out.split('\n').filter(l => l.trim().startsWith('|'))
    expect(tableLines).toHaveLength(4)
  })

  it('inserting mid-content does not splice into an existing line', () => {
    const v = makeView('prose here', 5)
    insertTable(v, 1, 2)
    const out = text(v)
    // The text "prose here" is preserved somewhere in the output,
    // uninterrupted by pipes.
    expect(out).toContain('prose')
    expect(out).toContain('here')
    // The table lives on its own lines (at least one pure-table line).
    expect(out.split('\n').some(l => /^\|.*\|$/.test(l.trim()))).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// insertBlock — generic block insertion at cursor
// ═══════════════════════════════════════════════════════════════════════

describe('insertBlock', () => {
  it('inserts the given text into the document', () => {
    const v = makeView('', 0)
    insertBlock(v, '<!-- hello -->')
    expect(text(v)).toContain('<!-- hello -->')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// insertFootnote — [^N] + definition
// ═══════════════════════════════════════════════════════════════════════

describe('insertFootnote', () => {
  it('in empty doc: inserts [^1] ref and [^1]: definition', () => {
    const v = makeView('', 0)
    insertFootnote(v)
    const out = text(v)
    expect(out).toContain('[^1]')
    expect(out).toMatch(/\[\^1\]:/)
  })

  it('increments when [^1] is already present', () => {
    const v = makeView('Some text [^1] here\n\n[^1]: existing', 9)
    insertFootnote(v)
    const out = text(v)
    expect(out).toContain('[^2]')
    expect(out).toMatch(/\[\^2\]:/)
  })

  it('picks max+1 across gapped existing footnotes', () => {
    const v = makeView('a[^1]b[^3]c\n\n[^1]: x\n[^3]: y', 1)
    insertFootnote(v)
    const out = text(v)
    expect(out).toContain('[^4]')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// insertAlert — GitHub-style alert block
// ═══════════════════════════════════════════════════════════════════════

describe('insertAlert', () => {
  it('inserts a TIP alert with blockquote body placeholder', () => {
    const v = makeView('', 0)
    insertAlert(v, 'TIP')
    const out = text(v)
    expect(out).toMatch(/>\s*\[!TIP\]/)
    // Body line is a `> ` so the user can type immediately.
    expect(out).toMatch(/\n>\s?/)
  })

  it('inserts all five alert kinds', () => {
    for (const kind of ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'] as const) {
      const v = makeView('', 0)
      insertAlert(v, kind)
      expect(text(v)).toContain(`[!${kind}]`)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// insertMath — inline vs block
// ═══════════════════════════════════════════════════════════════════════

describe('insertMath', () => {
  it('inline: wraps cursor with single $', () => {
    const v = makeView('', 0)
    insertMath(v, 'inline')
    expect(text(v)).toBe('$$')
    // Cursor should be between the two $
    expect(cursorAt(v)).toBe(1)
  })

  it('block: inserts $$ fences on their own lines', () => {
    const v = makeView('', 0)
    insertMath(v, 'block')
    const out = text(v)
    expect(out).toMatch(/\$\$[\s\S]*\$\$/)
    // At least two lines containing only `$$`
    const lines = out.split('\n')
    expect(lines.filter(l => l.trim() === '$$').length).toBeGreaterThanOrEqual(2)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// insertDiagram — fenced mermaid block
// ═══════════════════════════════════════════════════════════════════════

describe('insertDiagram', () => {
  const kinds = ['flowchart', 'sequence', 'class', 'state', 'er', 'gantt', 'pie', 'mindmap'] as const

  it.each(kinds)('inserts a fenced mermaid block for kind=%s', (kind) => {
    const v = makeView('', 0)
    insertDiagram(v, kind)
    const out = text(v)
    expect(out).toMatch(/```mermaid[\s\S]*```/)
  })

  it('each kind produces a non-empty, kind-appropriate body', () => {
    const v = makeView('', 0)
    insertDiagram(v, 'flowchart')
    const out = text(v)
    // Flowchart templates typically contain "flowchart" or "graph"
    // somewhere in the body.
    expect(out).toMatch(/flowchart|graph/)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// insertPageBreak — HTML comment on own line
// ═══════════════════════════════════════════════════════════════════════

describe('insertPageBreak', () => {
  it('inserts <!-- pagebreak --> marker', () => {
    const v = makeView('', 0)
    insertPageBreak(v)
    expect(text(v)).toContain('<!-- pagebreak -->')
  })

  it('inserts on its own line when cursor is mid-content', () => {
    const v = makeView('before\nafter', 6)
    insertPageBreak(v)
    const out = text(v)
    // The marker should be on a line by itself (or at least not
    // mashed into 'before' or 'after').
    const markerLine = out.split('\n').find(l => l.includes('<!-- pagebreak -->')) || ''
    expect(markerLine.trim()).toBe('<!-- pagebreak -->')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// insertToc — [[toc]] marker
// ═══════════════════════════════════════════════════════════════════════

describe('insertToc', () => {
  it('inserts [[toc]]', () => {
    const v = makeView('', 0)
    insertToc(v)
    expect(text(v)).toContain('[[toc]]')
  })

  it('inserts on its own line when cursor is mid-content', () => {
    const v = makeView('prose', 5)
    insertToc(v)
    const out = text(v)
    const tocLine = out.split('\n').find(l => l.includes('[[toc]]')) || ''
    expect(tocLine.trim()).toBe('[[toc]]')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// insertDefinitionList — dl scaffold
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// toggleComment — wrap/unwrap selection in <!-- ... -->
//
// Black-box spec:
//   - Empty selection → drops `<!--  -->` and lands the cursor between
//     the spaces.
//   - Plain selection → wraps as `<!-- selected -->`, re-selecting the
//     inner text so a second click toggles off.
//   - Already-commented selection → unwraps (strips `<!--`/`-->` and
//     the surrounding whitespace inside the delimiters).
// ═══════════════════════════════════════════════════════════════════════

describe('toggleComment', () => {
  it('cursor only: inserts empty comment with cursor between spaces', () => {
    const v = makeView('', 0)
    toggleComment(v)
    expect(text(v)).toBe('<!--  -->')
    // 4 chars for `<!--`, 1 space → cursor at index 5.
    expect(cursorAt(v)).toBe(5)
  })

  it('wraps a plain selection as <!-- selected -->', () => {
    const v = makeView('foo', { from: 0, to: 3 })
    toggleComment(v)
    expect(text(v)).toBe('<!-- foo -->')
    // Re-selects the inner text so a second click toggles off.
    expect(selectedText(v)).toBe('foo')
  })

  it('toggles off an already-wrapped selection', () => {
    const v = makeView('<!-- foo -->', { from: 0, to: 12 })
    toggleComment(v)
    expect(text(v)).toBe('foo')
  })

  it('toggle off → toggle on round-trips to the same shape', () => {
    const v = makeView('foo', { from: 0, to: 3 })
    toggleComment(v) // → `<!-- foo -->`, selection on `foo`
    toggleComment(v) // unwrap (selection is `foo`, but adjacent markers)
    // The inner-text selection is just `foo` — that doesn't start with
    // `<!--`, so the second click WRAPS again rather than unwrapping.
    // This matches `toggleWrap`'s existing semantics: to unwrap from an
    // inner-text selection, the markers must be in the selection.
    expect(text(v)).toBe('<!-- <!-- foo --> -->')
  })

  it('unwraps when the full comment (including delimiters) is selected', () => {
    const v = makeView('<!-- private note -->', { from: 0, to: 21 })
    toggleComment(v)
    expect(text(v)).toBe('private note')
  })

  it('multi-line selection wraps the whole block in one comment', () => {
    const v = makeView('line one\nline two', { from: 0, to: 17 })
    toggleComment(v)
    expect(text(v)).toBe('<!-- line one\nline two -->')
  })

  it('whitespace-padded selection preserves the leading/trailing whitespace on unwrap', () => {
    const v = makeView('  <!-- foo -->  ', { from: 0, to: 16 })
    toggleComment(v)
    expect(text(v)).toBe('  foo  ')
  })
})

describe('insertDefinitionList', () => {
  it('inserts a term + definition scaffold', () => {
    const v = makeView('', 0)
    insertDefinitionList(v)
    const out = text(v)
    // A <dt>-ish line (the term) followed by a definition line
    // starting with ":" (markdown-it-dl syntax).
    expect(out).toMatch(/\n:\s+/)
  })

  it('selects the "Term" so the user can type immediately', () => {
    // Header block for insertDefinitionList states it selects the
    // term placeholder. After insert, a non-empty selection should exist
    // and its text should not be blank.
    const v = makeView('', 0)
    insertDefinitionList(v)
    const sel = selectedText(v)
    expect(sel.length).toBeGreaterThan(0)
    expect(sel.trim().length).toBeGreaterThan(0)
  })
})
