import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DOCS_SECTIONS, DOCS_SECTION_TITLES, docsSectionTitle, isDocsPath } from '../../../shared/docs/docsSections'

const DOCS_DIR = path.resolve('content/docs')

function frontmatter(file: string): Record<string, string> {
  const text = fs.readFileSync(path.join(DOCS_DIR, file), 'utf8')
  const block = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ''
  const out: Record<string, string> = {}
  for (const line of block.split('\n')) {
    const match = /^([A-Za-z]+):\s*(.*)$/.exec(line)
    if (match?.[1]) out[match[1]] = match[2] ?? ''
  }
  return out
}

describe('docs sections', () => {
  const folders = fs.readdirSync(DOCS_DIR, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)

  it('lists exactly the folders under content/docs', () => {
    expect([...DOCS_SECTIONS].sort()).toEqual([...folders].sort())
  })

  it('gives every section an index page with title, description, icon and its sidebar position', () => {
    DOCS_SECTIONS.forEach((slug, i) => {
      const fm = frontmatter(`${slug}/index.md`)
      expect(fm.title, slug).toBe(DOCS_SECTION_TITLES[slug])
      expect(fm.description, slug).toBeTruthy()
      expect(fm.icon, slug).toMatch(/^i-lucide-/)
      expect(Number(fm.order), slug).toBe(i + 1)
    })
  })

  it('files every page under its folder, with its own position inside the section', () => {
    for (const slug of DOCS_SECTIONS) {
      const pages = fs.readdirSync(path.join(DOCS_DIR, slug)).filter(f => f.endsWith('.md') && f !== 'index.md')
      const orders = pages.map((page) => {
        const fm = frontmatter(`${slug}/${page}`)
        expect(fm.category, `${slug}/${page}`).toBe(slug)
        return Number(fm.order)
      })
      expect([...orders].sort((a, b) => a - b), slug).toEqual(pages.map((_, i) => i + 1))
    }
  })

  it('names a section by its title, and nothing else', () => {
    expect(docsSectionTitle('ai')).toBe('AI assistant')
    expect(docsSectionTitle('history')).toBeNull()
    expect(docsSectionTitle('toString')).toBeNull()
  })

  it('recognises the docs area by path', () => {
    expect(isDocsPath('/docs')).toBe(true)
    expect(isDocsPath('/docs/ai/overview?x=1')).toBe(true)
    expect(isDocsPath('/docs-old')).toBe(false)
    expect(isDocsPath('/d/abc')).toBe(false)
  })
})
