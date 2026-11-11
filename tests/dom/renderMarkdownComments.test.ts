import { describe, it, expect } from 'vitest'
import { renderMarkdown } from '../../app/utils/markdown/renderMarkdown'

// Comment-stripping behaviour for `<!-- ... -->` in the markdown
// pipeline. The contract:
//   - Block-level comments (single OR multi-line, on their own with no
//     trailing real content) are consumed entirely — emit nothing.
//   - Inline comments mid-paragraph are stripped in place; surrounding
//     prose flows around the gap.
//   - `<!-- pagebreak -->` keeps its special pagebreak meaning (the
//     pagebreak rule is registered first in the chain).
//   - Unterminated `<!--` falls back to literal escaped text — never
//     swallows the rest of the document.
//   - Comments inside fenced code blocks render literally (fences don't
//     run inline rules).
//
// The audit script (scripts/audit-markdown-pipeline.mjs) already
// demonstrates the same cases against the full plugin chain; this
// suite locks the expected output into CI so a future plugin order
// change can't silently break the contract.

describe('renderMarkdown — comment stripping', () => {
  it('block comment on its own line emits nothing', async () => {
    const out = await renderMarkdown('Before\n\n<!-- TODO: rewrite -->\n\nAfter')
    expect(out).not.toContain('TODO')
    expect(out).toContain('Before')
    expect(out).toContain('After')
  })

  it('multi-line block comment is consumed entirely', async () => {
    const out = await renderMarkdown('Before\n\n<!--\nprivate note\nspanning lines\n-->\n\nAfter')
    expect(out).not.toContain('private note')
    expect(out).not.toContain('spanning lines')
    expect(out).toContain('Before')
    expect(out).toContain('After')
  })

  it('inline comment mid-paragraph is stripped, surrounding prose preserved', async () => {
    const out = await renderMarkdown('This is text <!-- a private note --> with more text.')
    expect(out).not.toContain('private note')
    expect(out).toContain('This is text')
    expect(out).toContain('with more text.')
  })

  it('multiple inline comments in a single paragraph all stripped', async () => {
    const out = await renderMarkdown('a <!-- one --> b <!-- two --> c')
    expect(out).not.toContain('one')
    expect(out).not.toContain('two')
    expect(out).toMatch(/a\s+b\s+c/)
  })

  it('markdown inside a comment is NOT processed', async () => {
    const out = await renderMarkdown('<!-- **bold text** _italic_ [link](x) -->')
    // The bold delimiters and link wouldn't even reach the renderer
    // because the entire comment is consumed at the block stage.
    expect(out).not.toContain('<strong>')
    expect(out).not.toContain('<em>')
    expect(out).not.toContain('<a ')
    expect(out).not.toContain('bold text')
  })

  it('pagebreak keeps its pagebreak meaning (not stripped as a comment)', async () => {
    const out = await renderMarkdown('Before\n\n<!-- pagebreak -->\n\nAfter')
    expect(out).toContain('class="page-break"')
  })

  it('unterminated comment falls back to literal escaped text', async () => {
    const out = await renderMarkdown('Before\n\n<!-- never closed\n\nmore prose')
    // The `<!--` escapes to `&lt;!--` because html: false. Crucially,
    // "more prose" survives — we don't swallow the rest of the doc.
    expect(out).toContain('more prose')
    expect(out).toContain('&lt;!--')
  })

  it('comment inside a fenced code block stays literal', async () => {
    const out = await renderMarkdown('```\n<!-- visible in code -->\n```')
    // The whole comment text shows up in the rendered code block.
    expect(out).toContain('&lt;!-- visible in code --&gt;')
  })

  it('comment with trailing real content does NOT swallow the trailing content (block rule defers to inline)', async () => {
    const out = await renderMarkdown('<!-- note --> Real content.')
    expect(out).not.toContain('note')
    expect(out).toContain('Real content.')
  })
})
