import { describe, it, expect } from 'vitest'
import { chunkMarkdown } from '../../server/utils/chunkMarkdown'

// Hard-ceiling behaviour for the chunk splitter. The regular
// chunker behaviour has its own test file (chunkMarkdown.test.ts);
// these cases lock in the maxChunks cap specifically — a safety
// valve for pathological inputs that would otherwise translate into
// tens of thousands of embedding API calls.

describe('chunkMarkdown — maxChunks ceiling', () => {
  it('emits no more than maxChunks chunks', () => {
    // Enough small sections to comfortably exceed the cap.
    const md = Array.from({ length: 50 }, (_, i) =>
      `## Section ${i + 1}\n\nBody paragraph for section ${i + 1}.`
    ).join('\n\n')
    const chunks = chunkMarkdown(md, { targetTokens: 30, maxChunks: 5 })
    expect(chunks.length).toBeLessThanOrEqual(5)
  })

  it('replaces the tail with a single truncation sentinel', () => {
    const md = Array.from({ length: 20 }, (_, i) =>
      `## Section ${i + 1}\n\nBody ${i + 1}.`
    ).join('\n\n')
    const chunks = chunkMarkdown(md, { targetTokens: 20, maxChunks: 3 })
    expect(chunks).toHaveLength(3)
    expect(chunks[chunks.length - 1]!.content).toMatch(/truncated/i)
  })

  it('no-op when maxChunks is undefined', () => {
    const md = Array.from({ length: 6 }, (_, i) =>
      `## Section ${i + 1}\n\nBody paragraph for section ${i + 1}.`
    ).join('\n\n')
    const chunks = chunkMarkdown(md, { targetTokens: 20 })
    // 6 tiny sections, target 20 tokens, packing active — expect
    // something greater than 1 but no sentinel text.
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.content).not.toMatch(/truncated/i)
    }
  })

  it('no-op when under the cap', () => {
    const md = `## Section\n\nJust a little content.`
    const chunks = chunkMarkdown(md, { maxChunks: 100 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.content).not.toMatch(/truncated/i)
  })
})
