// @vitest-environment jsdom
//
// jsdom: the heading ids pass through `clobberSafeId`, which needs a DOM
// (same as renderMarkdownHeadingsCode.test.ts).
import { describe, it, expect } from 'vitest'
import { parseMarkdownTokens, renderMarkdown } from '../../app/utils/markdown/renderMarkdown'
import {
  activeHeadingIndex, buildOutlineTree, headingsFromTokens, maskFrontmatter,
  type OutlineHeading, type OutlineNode
} from '../../app/utils/editor/documentOutline'

// The editor's outline reads the headings the preview renders: from the
// same markdown-it pipeline, so code fences, comments and math blocks hide
// headings exactly as on the page, and each heading carries the id the
// preview scrolls to.

async function outline(source: string): Promise<OutlineHeading[]> {
  return headingsFromTokens(await parseMarkdownTokens(maskFrontmatter(source)))
}

/** The tree as nested [text, children] pairs. */
function shape(nodes: OutlineNode[]): unknown[] {
  return nodes.map(n => n.children.length > 0 ? [n.heading.text, shape(n.children)] : n.heading.text)
}

describe('outline headings', () => {
  it('lists ATX and setext headings with level, text and source line', async () => {
    const src = '# Report\n\nIntro.\n\nMethods\n=======\n\nResults\n-------\n\n### Details ###\n'
    expect(await outline(src)).toEqual([
      { id: 'report', level: 1, text: 'Report', line: 0 },
      { id: 'methods', level: 1, text: 'Methods', line: 4 },
      { id: 'results', level: 2, text: 'Results', line: 7 },
      { id: 'details', level: 3, text: 'Details', line: 10 }
    ])
  })

  it('ignores headings inside code fences, indented code, comments and math blocks', async () => {
    const src = [
      '# Real',
      '',
      '```bash',
      '# not a heading, a shell comment',
      '```',
      '',
      '~~~~',
      '## still code',
      '~~~~',
      '',
      '    # indented code',
      '',
      '<!--',
      '# hidden from the preview',
      '-->',
      '',
      '$$',
      '# x = 1',
      '$$',
      '',
      '## Also real'
    ].join('\n')
    expect((await outline(src)).map(h => h.text)).toEqual(['Real', 'Also real'])
  })

  it('leaves out a leading YAML frontmatter block but keeps the line numbers', async () => {
    const src = '---\ntitle: Q3 report\nauthor: Maya\n---\n\n# Q3 report\n\n## Revenue\n'
    expect(await outline(src)).toEqual([
      { id: 'q3-report', level: 1, text: 'Q3 report', line: 5 },
      { id: 'revenue', level: 2, text: 'Revenue', line: 7 }
    ])
  })

  it('keeps a thematic break at the top that is not frontmatter', async () => {
    expect(maskFrontmatter('---\n\nJust text\n---\n')).toBe('---\n\nJust text\n---\n')
    expect(maskFrontmatter('---\n---\n# A\n')).toBe('---\n---\n# A\n')
    expect(maskFrontmatter('--- \nkey: v\n...\n# A')).toBe('\n\n\n# A')
    expect(maskFrontmatter('No frontmatter')).toBe('No frontmatter')
    expect(maskFrontmatter('---\nkey: never closed\n# A')).toBe('---\nkey: never closed\n# A')
  })

  it('gives duplicates the ids the preview renders, and reads explicit ids', async () => {
    const src = '## Notes\n\n## Notes\n\n## Notes {#third}\n\n## Method\n'
    const headings = await outline(src)
    expect(headings.map(h => h.id)).toEqual(['notes', 'notes-1', 'third', 'method-section'])
    const html = await renderMarkdown(src)
    for (const h of headings) expect(html).toContain(`id="${h.id}"`)
  })

  it('reduces inline Markdown to the visible text', async () => {
    // A setext heading may run over several lines.
    const src = '# The **bold** and `code` [link](https://example.com) :tada:\n\nLine one\nline two\n---\n'
    const [first, second] = await outline(src)
    expect(first?.text).toBe('The bold and code link 🎉')
    expect(second?.text).toBe('Line one line two')
  })

  it('skips headings without text and returns nothing for an empty document', async () => {
    expect(await outline('#\n\n## \n\nText only.\n')).toEqual([])
    expect(await outline('')).toEqual([])
  })

  it('finds headings inside block quotes and lists, as the preview shows them', async () => {
    expect((await outline('> ## Quoted\n\n- ### In a list\n')).map(h => [h.level, h.text])).toEqual([[2, 'Quoted'], [3, 'In a list']])
  })

  it('reads a 10 000-word document in well under a frame budget per keystroke pause', async () => {
    const para = 'The quick brown fox jumps over the lazy dog and keeps running far away. '.repeat(10)
    const sections: string[] = []
    for (let i = 0; i < 140; i++) sections.push(`## Section ${i}`, '', para, '', '```ts', '# not', '```', '')
    const src = `# Handbook\n\n${sections.join('\n')}`
    expect(src.split(/\s+/).length).toBeGreaterThan(10_000)
    await outline(src)
    const started = performance.now()
    const headings = await outline(src)
    const elapsed = performance.now() - started
    expect(headings).toHaveLength(141)
    // Generous for slow CI machines; locally it is a few milliseconds.
    expect(elapsed).toBeLessThan(500)
  })
})

describe('outline tree', () => {
  const h = (level: number, text: string, line = 0): OutlineHeading => ({ id: text.toLowerCase(), level, text, line })

  it('nests each heading under the nearest one above it with a lower level', () => {
    const tree = buildOutlineTree([h(1, 'A'), h(2, 'A1'), h(3, 'A1a'), h(2, 'A2'), h(1, 'B'), h(2, 'B1')])
    expect(shape(tree)).toEqual([['A', [['A1', ['A1a']], 'A2']], ['B', ['B1']]])
    expect(tree[1]?.index).toBe(4)
  })

  it('nests a skipped level one step and keeps a document starting below h1 flat', () => {
    expect(shape(buildOutlineTree([h(1, 'A'), h(3, 'deep'), h(2, 'mid')]))).toEqual([['A', ['deep', 'mid']]])
    expect(shape(buildOutlineTree([h(2, 'x'), h(2, 'y'), h(3, 'y1')]))).toEqual(['x', ['y', ['y1']]])
  })

  it('finds the section of a line', () => {
    const list = [h(1, 'A', 2), h(2, 'B', 10), h(2, 'C', 20)]
    expect(activeHeadingIndex(list, 0)).toBe(-1)
    expect(activeHeadingIndex(list, 2)).toBe(0)
    expect(activeHeadingIndex(list, 15)).toBe(1)
    expect(activeHeadingIndex(list, 999)).toBe(2)
    expect(activeHeadingIndex([], 5)).toBe(-1)
  })
})
