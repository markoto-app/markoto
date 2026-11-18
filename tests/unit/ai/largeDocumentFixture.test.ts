import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { generateLargeDocument, LARGE_DOC_FAKE_DOC_ID, LARGE_DOC_FIXTURE_PATH } from '../../fixtures/largeDocument/generate'

// The large-document fixture the AI benchmark (tests/bench/ai/) runs on. The
// benchmark's numbers are only comparable across runs while the document stays
// the same, so its shape and its determinism are pinned here.

const doc = generateLargeDocument()

/** Headings outside fenced code blocks (a `# comment` in a bash block is not one). */
function headings(text: string): string[] {
  const out: string[] = []
  let inFence = false
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence
    else if (!inFence && /^#{1,6} /.test(line)) out.push(line)
  }
  return out
}

describe('large document fixture', () => {
  it('is deterministic and matches the committed copy', () => {
    expect(generateLargeDocument()).toBe(doc)
    expect(readFileSync(LARGE_DOC_FIXTURE_PATH, 'utf8')).toBe(doc)
  })

  it('changes with the seed', () => {
    expect(generateLargeDocument({ seed: 1 })).not.toBe(doc)
  })

  it('is book length (75k to 85k words, under 700 KB)', () => {
    const words = doc.split(/\s+/).filter(Boolean).length
    expect(words).toBeGreaterThanOrEqual(75_000)
    expect(words).toBeLessThanOrEqual(85_000)
    expect(Buffer.byteLength(doc, 'utf8')).toBeLessThan(700 * 1024)
  })

  it('has numbered chapters, sections and subsections', () => {
    const hs = headings(doc)
    const h1 = hs.filter(h => h.startsWith('# '))
    const h2 = hs.filter(h => h.startsWith('## '))
    const h3 = hs.filter(h => h.startsWith('### '))
    expect(h1).toHaveLength(14)
    expect(h1[2]).toBe('# 3 Netzbetrieb {#netzbetrieb}')
    expect(h2.length).toBeGreaterThanOrEqual(50)
    expect(h3.length).toBeGreaterThanOrEqual(150)
    expect(h2.every(h => /^## \d+\.\d+ /.test(h))).toBe(true)
    // Lines starting with `#` inside code blocks are no headings.
    expect(doc).toContain('\n# Erstbeurteilung: Zustand der wichtigsten Dienste abfragen\n')
    expect(hs).not.toContain('# Erstbeurteilung: Zustand der wichtigsten Dienste abfragen')
  })

  it('opens with a preamble before the first heading', () => {
    const firstHeading = doc.indexOf('\n# ')
    expect(firstHeading).toBeGreaterThan(200)
    expect(doc.slice(0, firstHeading)).toContain('[[toc]]')
  })

  it('carries every construct a large-document tool must survive', () => {
    expect(doc).toMatch(/^\| .+ \|$/m) // table
    expect(doc).toContain('```mermaid\n')
    expect(doc).toContain('```bash\n')
    expect(doc).toMatch(/`[a-z]+ [^`]+`/) // inline code
    expect(doc).toMatch(/\$P = U .+\$/) // inline math
    expect(doc).toContain('$$\nA = \\frac')
    expect(doc).toMatch(new RegExp(String.raw`!\[[^\]]+\]\(/api/files/${LARGE_DOC_FAKE_DOC_ID}/[A-Za-z0-9]+\.png\)`))
    expect(doc).toMatch(/\[\^1\]: /)
    expect(doc).toMatch(/[^\n]\[\^1\]/)
    expect(doc).toMatch(/\[[^\]]+\]\(#eskalation\)/)
    expect(doc).toMatch(/\[[^\]]+\]\(https:\/\/www\.example\.org\/[^)]+\)/)
    expect(doc).toContain('{#eskalation}')
    expect(doc).toContain('> [!NOTE]\n')
    expect(doc).toContain('<!-- pagebreak -->')
    expect(doc).toContain('- [ ] ')
    expect(doc).toContain('*[USV]: ')
  })

  it('names customers about 40 times in about 19 sections, and nowhere in compounds', () => {
    expect(doc.match(/\bKund(?:e|en|in|innen)\b/g)?.length).toBe(40)
    expect(doc.match(/Kund/g)?.length).toBe(40)
    const sections = doc.split(/\n## /).filter(s => /\bKund(?:e|en|in|innen)\b/.test(s))
    expect(sections.length).toBeGreaterThanOrEqual(17)
  })

  it('uses Swiss spelling and no em dash', () => {
    const sharpS = String.fromCodePoint(0xDF)
    const emDash = String.fromCodePoint(0x2014)
    expect(doc).not.toContain(sharpS)
    expect(doc).not.toContain(emDash)
  })
})
