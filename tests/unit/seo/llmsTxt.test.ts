import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  buildLlmsFullTxt,
  buildLlmsTxt,
  cleanDocsMarkdown,
  contentRoute,
  docsSections,
  marketingGroups,
  splitFrontmatter,
  type SourceFile
} from '../../../server/utils/platform/llmsTxt'

// llms.txt + llms-full.txt (llmstxt.org) from content/docs and the English
// marketing pages (server/utils/platform/llmsTxt.ts).

const BASE = 'https://markoto.app'

const DOCS: SourceFile[] = [
  { path: 'writing/index.md', raw: '---\ntitle: Write\ndescription: Writing guides.\norder: 2\n---\n\n# Write\n\nIntro.\n' },
  { path: 'writing/tables.md', raw: '---\ntitle: Tables\ndescription: Make tables.\norder: 2\n---\n\n# Tables\n\nSee [math](/docs/writing/math).\n\n::flow{id="tables" hide-title}\n::\n\nAfter.\n' },
  { path: 'writing/math.md', raw: '---\ntitle: Math\norder: 1\n---\n\n# Math\n\nInline :kbd{value="x"} text.\n\n```md\n::not-a-component\n```\n' },
  { path: 'getting-started/index.md', raw: '---\ntitle: Get started\ndescription: Start here.\norder: 1\n---\n\n# Get started\n\nHello.\n' }
]

const MARKETING: SourceFile[] = [
  { path: 'markdown-to-pdf.md', raw: '---\ntitle: Markdown to PDF\ndescription: Real pages.\nnavGroup: use-cases\n---\nBody' },
  { path: 'compare/index.md', raw: '---\ntitle: Compare\ndescription: All comparisons.\nnavGroup: compare\nnavOrder: 0\n---\nBody' },
  { path: 'compare/hackmd.md', raw: '---\ntitle: markoto vs HackMD\ndescription: Side by side.\nnavGroup: compare\nnavOrder: 1\n---\nBody' },
  { path: 'self-hosted-markdown-editor.md', raw: '---\ntitle: Self-hosted\ndescription: Run it yourself.\n---\nBody' },
  { path: 'draft.md', raw: '---\ntitle: Draft\nreviewed: false\n---\nBody' }
]

describe('frontmatter + routes', () => {
  it('splits YAML frontmatter from the body', () => {
    expect(splitFrontmatter('---\ntitle: A\norder: 3\n---\n\nText')).toEqual({ data: { title: 'A', order: 3 }, body: '\nText' })
    expect(splitFrontmatter('No frontmatter')).toEqual({ data: {}, body: 'No frontmatter' })
  })

  it('maps content files to routes, index pages to their folder', () => {
    expect(contentRoute('/docs', 'writing/tables.md')).toBe('/docs/writing/tables')
    expect(contentRoute('/docs', 'writing/index.md')).toBe('/docs/writing')
    expect(contentRoute('', 'compare/index.md')).toBe('/compare')
    expect(contentRoute('', 'markdown-to-pdf.md')).toBe('/markdown-to-pdf')
  })
})

describe('cleanDocsMarkdown', () => {
  it('removes MDC block and inline components, keeps code blocks, makes links absolute', () => {
    const out = cleanDocsMarkdown('Text [a](/docs/x) and [b](https://example.com).\n\n::flow{id="x"}\n::\n\n::callout\nInside\n::\n\nKey :kbd{value="K"} here.\n\n```\n::kept\n[c](/docs/y)\n```\n\n\n\nEnd', BASE)
    expect(out).toBe('Text [a](https://markoto.app/docs/x) and [b](https://example.com).\n\nKey K here.\n\n```\n::kept\n[c](/docs/y)\n```\n\nEnd')
  })
})

describe('docsSections + marketingGroups', () => {
  it('orders sections and pages like the sidebar, index page first', () => {
    const sections = docsSections(DOCS, BASE)
    expect(sections.map(s => s.title)).toEqual(['Get started', 'Write'])
    expect(sections[1]?.pages.map(p => p.title)).toEqual(['Write', 'Math', 'Tables'])
    expect(sections[1]?.pages[2]?.url).toBe(`${BASE}/docs/writing/tables`)
  })

  it('groups the marketing pages like the footer and leaves out unreviewed ones', () => {
    const groups = marketingGroups(MARKETING, BASE)
    expect(groups.map(g => g.title)).toEqual(['Use cases', 'Comparisons', 'More pages'])
    expect(groups[1]?.pages.map(p => p.url)).toEqual([`${BASE}/compare`, `${BASE}/compare/hackmd`])
    expect(JSON.stringify(groups)).not.toContain('Draft')
  })
})

describe('buildLlmsTxt', () => {
  const text = buildLlmsTxt({ base: BASE, docs: DOCS, marketing: MARKETING })

  it('follows the llmstxt.org shape: H1, summary blockquote, H2 link lists', () => {
    const lines = text.split('\n')
    expect(lines[0]).toBe('# markoto')
    expect(lines[2]?.startsWith('> ')).toBe(true)
    expect(text).toContain('## Product\n\n- [markoto](https://markoto.app/): ')
    expect(text).toContain('- [Pricing](https://markoto.app/pricing): ')
    expect(text).toContain('## Use cases\n\n- [Markdown to PDF](https://markoto.app/markdown-to-pdf): Real pages.')
    expect(text).toContain('## Docs: Write\n\n- [Write](https://markoto.app/docs/writing): Writing guides.')
    expect(text).toContain('- [Math](https://markoto.app/docs/writing/math)\n')
    expect(text).toContain(`${BASE}/llms-full.txt`)
    expect(text.endsWith('\n')).toBe(true)
  })
})

describe('buildLlmsFullTxt', () => {
  const text = buildLlmsFullTxt({ base: BASE, docs: DOCS })

  it('holds every docs page once, in order, without MDC components or frontmatter', () => {
    expect(text.startsWith('# markoto documentation\n')).toBe(true)
    const titles = [...text.matchAll(/^# (.+)$/gm)].map(m => m[1])
    expect(titles).toEqual(['markoto documentation', 'Get started', 'Write', 'Math', 'Tables'])
    expect(text).toContain(`Source: ${BASE}/docs/writing/tables`)
    expect(text).not.toContain('::flow')
    expect(text).not.toContain(':kbd')
    expect(text).not.toContain('order: 2')
    expect(text).toContain('See [math](https://markoto.app/docs/writing/math).')
  })
})

describe('the committed content', () => {
  function files(dir: string): SourceFile[] {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.md'))
      .map(e => join(e.parentPath, e.name))
      .map(f => ({ path: relative(dir, f).split(sep).join('/'), raw: readFileSync(f, 'utf8') }))
  }
  const root = join(__dirname, '..', '..', '..', 'content')
  const docs = files(join(root, 'docs'))
  const marketing = files(join(root, 'marketing', 'en'))

  it('every docs page is in llms.txt with its frontmatter description, and in llms-full.txt', () => {
    const index = buildLlmsTxt({ base: BASE, docs, marketing })
    const full = buildLlmsFullTxt({ base: BASE, docs })
    for (const file of docs) {
      const { data } = splitFrontmatter(file.raw)
      const url = `${BASE}${contentRoute('/docs', file.path)}`
      expect(index, file.path).toContain(`[${data.title}](${url})${data.description ? `: ${data.description}` : ''}`)
      expect(full, file.path).toContain(`Source: ${url}\n`)
    }
  })

  it('llms-full.txt has no Nuxt Content components left outside code blocks', () => {
    const full = buildLlmsFullTxt({ base: BASE, docs })
    const outsideCode = full.replace(/^(```|~~~)[\s\S]*?^\1/gm, '')
    expect(outsideCode).not.toMatch(/^\s*::/m)
  })
})
