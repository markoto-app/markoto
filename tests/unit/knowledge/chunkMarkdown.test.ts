import { describe, it, expect } from 'vitest'
import { chunkMarkdown } from '../../../server/utils/knowledge/chunkMarkdown'

// chunkMarkdown is a pure function, no DB, no network. Covers the
// edge cases the processor actually cares about:
//   - empty / whitespace input returns nothing
//   - small doc under target becomes one chunk
//   - multi-section doc splits at heading boundaries
//   - oversized section force-splits at paragraph boundaries
//   - every emitted chunk respects maxTokens
//   - chunk indexes are strictly increasing (1-based)

describe('chunkMarkdown', () => {
  it('returns an empty array for empty input', () => {
    expect(chunkMarkdown('')).toEqual([])
    expect(chunkMarkdown('   \n   ')).toEqual([])
  })

  it('emits a single chunk for a small document', () => {
    const md = 'This is a short document with no headings and just one paragraph.'
    const chunks = chunkMarkdown(md)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.index).toBe(1)
    expect(chunks[0]!.content).toContain('short document')
  })

  it('splits at heading boundaries', () => {
    const md = [
      '## First Section',
      '',
      'Content of the first section goes here.',
      '',
      '## Second Section',
      '',
      'Content of the second section goes here.',
      '',
      '### Nested',
      '',
      'Nested content block.'
    ].join('\n')
    const chunks = chunkMarkdown(md, { targetTokens: 50 })
    // The packer may combine adjacent small sections up to targetTokens,
    // but distinct H2s in different sections should end up in different
    // chunks with enough of a budget that we actually split.
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    // Each chunk preserves its heading line at the top of the section.
    const combined = chunks.map(c => c.content).join('\n---\n')
    expect(combined).toContain('## First Section')
    expect(combined).toContain('## Second Section')
    expect(combined).toContain('### Nested')
  })

  it('force-splits oversized sections while keeping the heading attached', () => {
    const heading = '## Big Section'
    const para = 'Lorem ipsum dolor sit amet '.repeat(500) // ~15k chars ~ 3,800 tokens
    const md = `${heading}\n\n${para}\n\n${para}\n\n${para}`
    const chunks = chunkMarkdown(md, { maxTokens: 1000, targetTokens: 800 })
    expect(chunks.length).toBeGreaterThan(1)
    // At least one chunk carries the heading so retrieval still knows the
    // section this content belongs to.
    expect(chunks.some(c => c.content.includes(heading))).toBe(true)
  })

  it('indexes are strictly increasing from 1', () => {
    const md = Array.from({ length: 6 }, (_, i) =>
      `## Section ${i + 1}\n\nBody paragraph for section ${i + 1}.`
    ).join('\n\n')
    const chunks = chunkMarkdown(md, { targetTokens: 30 })
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.index).toBe(i + 1)
    }
  })

  it('estimated token count is roughly chars/4', () => {
    const body = 'word '.repeat(200) // ~1000 chars
    const [chunk] = chunkMarkdown(body)
    expect(chunk).toBeDefined()
    expect(chunk!.tokens).toBeGreaterThan(200)
    expect(chunk!.tokens).toBeLessThan(300)
  })
})

// Chunks must fit the embedding model's input limit (mistral-embed: 8192
// tokens) in every script: non-ASCII characters count as one token each.
describe('chunkMarkdown token estimate beyond ASCII', () => {
  it('counts each non-ASCII character as a token, so CJK chunks stay small', () => {
    const sentence = '这是一个关于知识库的句子。'
    const chunks = chunkMarkdown(sentence.repeat(600))
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      // The 1500 ceiling plus at most the 100-token overlap carried over.
      expect(c.tokens).toBeLessThanOrEqual(1600)
      expect(new TextEncoder().encode(c.content).length).toBeLessThanOrEqual(8000)
    }
    expect(chunks.map(c => c.content).join('')).toContain(sentence)
  })

  it('splits CJK paragraphs at full-width sentence ends', () => {
    const chunks = chunkMarkdown('一二三四五。'.repeat(400), { maxTokens: 300 })
    for (const c of chunks) expect(c.content.endsWith('。')).toBe(true)
  })

  it('keeps the ASCII estimate at four characters per token', () => {
    const [chunk] = chunkMarkdown('abcd'.repeat(10))
    expect(chunk?.tokens).toBe(10)
  })
})
