import { describe, expect, it } from 'vitest'
import { blockSpacedInsertText, lineToCharOffset } from '../../../server/utils/ai/tools/documentText'

// Staging finding N19: a section the AI appended at the end of the
// document followed the last paragraph with a single newline. insert_text
// now adds the blank lines a Markdown block needs, and never doubles them.

/** Apply insert_text the way the tool does and return the document. */
function insert(full: string, insertLine: number, text: string): string {
  const idx = lineToCharOffset(full, insertLine)
  if (idx === null) throw new Error('line out of range')
  return full.slice(0, idx) + blockSpacedInsertText(full, idx, text) + full.slice(idx)
}

describe('blockSpacedInsertText', () => {
  it('separates a heading appended after the last paragraph', () => {
    expect(insert('# Title\n\nLast paragraph.\n', 3, '## Next steps')).toBe('# Title\n\nLast paragraph.\n\n## Next steps\n')
  })

  it('starts on a new line when the document has no trailing newline', () => {
    expect(insert('# Title\n\nLast paragraph.', 3, '## Next steps')).toBe('# Title\n\nLast paragraph.\n\n## Next steps\n')
  })

  it('does not double a blank line that is already there', () => {
    expect(insert('# Title\n\nLast paragraph.\n\n', 4, '## Next steps')).toBe('# Title\n\nLast paragraph.\n\n## Next steps\n')
    expect(insert('# Title\n\nLast paragraph.\n', 3, '\n## Next steps\n')).toBe('# Title\n\nLast paragraph.\n\n## Next steps\n')
  })

  it('adds a blank line below when the insertion meets the next block', () => {
    expect(insert('# Title\nIntro.\n', 1, 'A new paragraph.')).toBe('# Title\n\nA new paragraph.\n\nIntro.\n')
    expect(insert('Intro.\n', 0, '![Chart](/api/files/d/x.png)')).toBe('![Chart](/api/files/d/x.png)\n\nIntro.\n')
  })

  it('keeps list items, table rows and quote lines together', () => {
    expect(insert('- one\n- two\n', 1, '- one and a half')).toBe('- one\n- one and a half\n- two\n')
    expect(insert('1. one\n2. two\n', 2, '3. three')).toBe('1. one\n2. two\n3. three\n')
    expect(insert('| a | b |\n|---|---|\n| 1 | 2 |\n', 3, '| 3 | 4 |')).toBe('| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n')
    expect(insert('> quoted\n', 1, '> more')).toBe('> quoted\n> more\n')
  })

  it('separates a list from a paragraph', () => {
    expect(insert('Intro.\n', 1, '- one\n- two')).toBe('Intro.\n\n- one\n- two\n')
    expect(insert('- one\n', 1, 'After the list.')).toBe('- one\n\nAfter the list.\n')
  })

  it('leaves indented lines (nested lists, continuations) alone', () => {
    expect(insert('- one\n  - nested\n', 2, '  - nested two')).toBe('- one\n  - nested\n  - nested two\n')
  })

  it('never touches text inside a fenced code block', () => {
    expect(insert('```ts\nconst a = 1\n```\n', 2, 'const b = 2')).toBe('```ts\nconst a = 1\nconst b = 2\n```\n')
    expect(insert('Text.\n\n~~~\ncode\n~~~\n', 4, 'more code')).toBe('Text.\n\n~~~\ncode\nmore code\n~~~\n')
  })

  it('separates a code block from the paragraph before it', () => {
    expect(insert('Text.\n', 1, '```\ncode\n```')).toBe('Text.\n\n```\ncode\n```\n')
  })

  it('inserts into an empty document unchanged', () => {
    expect(insert('', 0, '# Title')).toBe('# Title\n')
    expect(insert('', 0, '\n')).toBe('\n')
  })
})
