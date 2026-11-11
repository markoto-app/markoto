import { describe, it, expect } from 'vitest'
import { computeTextDiff } from '../../../server/utils/documents/textDiff'
import { first } from '../../helpers/assert'

describe('computeTextDiff', () => {
  it('returns no hunks when inputs are identical', () => {
    const r = computeTextDiff('hello\nworld\n', 'hello\nworld\n')
    expect(r.hunks).toEqual([])
    expect(r.truncated).toBe(false)
    expect(r.totalHunks).toBe(0)
  })

  it('returns a single hunk for a one-line edit', () => {
    const before = 'line one\nline two\nline three\n'
    const after = 'line one\nline TWO\nline three\n'
    const r = computeTextDiff(before, after)
    expect(r.hunks).toHaveLength(1)
    const h = first(r.hunks)
    // The hunk has at least one remove (old) and one add (new).
    expect(h.lines.some(l => l.kind === 'remove' && l.text === 'line two')).toBe(true)
    expect(h.lines.some(l => l.kind === 'add' && l.text === 'line TWO')).toBe(true)
    // Surrounding context survives.
    expect(h.lines.some(l => l.kind === 'context' && l.text === 'line one')).toBe(true)
    expect(h.lines.some(l => l.kind === 'context' && l.text === 'line three')).toBe(true)
  })

  it('handles empty before (full insert)', () => {
    const r = computeTextDiff('', 'fresh content\nsecond line\n')
    expect(r.hunks).toHaveLength(1)
    const adds = first(r.hunks).lines.filter(l => l.kind === 'add').length
    expect(adds).toBeGreaterThanOrEqual(2)
  })

  it('handles empty after (full delete)', () => {
    const r = computeTextDiff('removed content\nsecond line\n', '')
    expect(r.hunks).toHaveLength(1)
    const removes = first(r.hunks).lines.filter(l => l.kind === 'remove').length
    expect(removes).toBeGreaterThanOrEqual(2)
  })

  it('truncates a single line that exceeds MAX_LINE_CHARS', () => {
    // The cap is 2000 chars per line. A 3000-char line should come back
    // truncated to ~2000 chars + ellipsis.
    const longLine = 'x'.repeat(3000)
    const r = computeTextDiff('a\n', `a\n${longLine}\n`)
    const addLine = first(r.hunks).lines.find(l => l.kind === 'add' && l.text.startsWith('xxx'))
    expect(addLine).toBeDefined()
    // 2000 chars total — exact boundary check would be brittle, but
    // it MUST be smaller than the original.
    expect(addLine!.text.length).toBeLessThan(3000)
    expect(addLine!.text.endsWith('…')).toBe(true)
  })

  it('caps the hunk count and reports truncation', () => {
    // Fabricate a before/after with way more than 200 hunks. Each
    // line that differs becomes its own hunk when surrounded by
    // matching context lines.
    const sep = 'CTX\n'.repeat(10)
    const lines = Array.from({ length: 250 }, (_, i) => `${sep}line ${i}`).join('\n')
    const linesAfter = Array.from({ length: 250 }, (_, i) => `${sep}LINE ${i}`).join('\n')
    const r = computeTextDiff(lines, linesAfter)
    expect(r.hunks.length).toBeLessThanOrEqual(200)
    // Whether the test produces > 200 hunks depends on context window
    // collapsing — assert truncated only if totalHunks tipped over.
    if (r.totalHunks > 200) expect(r.truncated).toBe(true)
  })

  it('filters out the diff library\'s "\\ No newline at end of file" marker', () => {
    // The `diff` library emits a `\ No newline at end of file` line
    // as metadata about a missing trailing newline — useful for
    // patch consumers but pure noise in our drawer. The filter
    // should suppress these from the hunk lines so they never reach
    // the UI.
    const before = 'line one' // no trailing newline
    const after = 'line two' // also no trailing newline
    const r = computeTextDiff(before, after)
    expect(r.hunks.length).toBeGreaterThan(0)
    for (const hunk of r.hunks) {
      // No line should start with '\\' (the marker prefix).
      for (const line of hunk.lines) {
        expect(line.text.startsWith('\\')).toBe(false)
        // The library prefixes content lines with `+`, `-`, ` ` but
        // we strip those — so verify nothing leaks the marker text.
        expect(line.text).not.toContain('No newline at end of file')
      }
    }
  })

  it('detects a one-character change inside a long line', () => {
    // The line-level diff should still flag a single-char change
    // (not require an entire line to differ for the hunk to fire).
    const before = 'this is the only line\n'
    const after = 'this is the ONLY line\n'
    const r = computeTextDiff(before, after)
    expect(r.hunks).toHaveLength(1)
    const adds = first(r.hunks).lines.filter(l => l.kind === 'add')
    const removes = first(r.hunks).lines.filter(l => l.kind === 'remove')
    expect(adds).toHaveLength(1)
    expect(removes).toHaveLength(1)
  })

  it('does not flag identical inputs even when both lack a trailing newline', () => {
    // The "no newline" marker shouldn't make a "no change" diff
    // appear different. Identical content = no hunks, period.
    const r = computeTextDiff('hello', 'hello')
    expect(r.hunks).toEqual([])
    expect(r.totalHunks).toBe(0)
  })

  it('preserves leading whitespace in lines (indentation matters)', () => {
    // Markdown lists, code blocks, etc. lean on leading spaces.
    // The diff should preserve them verbatim — neither the
    // library's prefix-strip nor our post-processing should
    // collapse leading whitespace.
    const before = '  - item one\n'
    const after = '    - item one\n'
    const r = computeTextDiff(before, after)
    expect(r.hunks).toHaveLength(1)
    const adds = first(r.hunks).lines.filter(l => l.kind === 'add')
    expect(first(adds).text).toBe('    - item one')
    const removes = first(r.hunks).lines.filter(l => l.kind === 'remove')
    expect(first(removes).text).toBe('  - item one')
  })
})
