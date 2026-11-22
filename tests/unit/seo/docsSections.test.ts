import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DOCS_SECTIONS, DOCS_SECTION_TITLES, docsNavSections, docsPagerNeighbours, docsReadingOrder, docsSectionIndex,
  docsSectionTitle, isDocsPath, sortDocsNav, sortDocsNavTree, type DocsNavNode
} from '../../../shared/docs/docsSections'

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

// The tree Nuxt Content's queryCollectionNavigation('docs') returns, built
// from the files: one root node, a node per folder (its index page also
// listed as a child of itself), everything in file-path order.
function navigationAsStored(): DocsNavNode[] {
  const node = (file: string, route: string): DocsNavNode => {
    const fm = frontmatter(file)
    return { title: fm.title ?? '', path: route, order: Number(fm.order), description: fm.description }
  }
  const folders = fs.readdirSync(DOCS_DIR, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort()
  const sections = folders.map((slug) => {
    const files = fs.readdirSync(path.join(DOCS_DIR, slug)).filter(f => f.endsWith('.md')).sort()
    const children = files.map(f => node(`${slug}/${f}`, f === 'index.md' ? `/docs/${slug}` : `/docs/${slug}/${f.replace(/\.md$/, '')}`))
    return { ...node(`${slug}/index.md`, `/docs/${slug}`), children }
  })
  return [{ title: 'Docs', path: '/docs', children: sections }]
}

describe('docs reading order (prev / next pager)', () => {
  const sections = docsNavSections(navigationAsStored())

  // What a reader sees going down the sidebar with every group open.
  const sidebarOrder = sortDocsNav(sections).flatMap(section => [
    section.path,
    ...sortDocsNav(section.children).filter(child => child.path !== section.path).map(child => child.path)
  ])

  it('is the sidebar order: sections in order, each section index followed by its pages by `order`', () => {
    const pager = docsReadingOrder(sections).map(page => page.path)
    expect(pager).toEqual(sidebarOrder)
    expect(new Set(pager).size).toBe(pager.length)
    expect(pager.filter(p => p.split('/').length === 3)).toEqual(DOCS_SECTIONS.map(slug => `/docs/${slug}`))
    expect(pager.slice(0, 3)).toEqual(['/docs/getting-started', '/docs/getting-started/quick-share', '/docs/getting-started/templates'])
    expect(pager.at(-1)).toBe('/docs/self-hosting')
  })

  it('does not follow the file-path order', () => {
    const collaborate = docsReadingOrder(sections).map(p => p.path).filter(p => p.startsWith('/docs/collaborate/'))
    expect(collaborate).toEqual(['/docs/collaborate/live-collab', '/docs/collaborate/comments', '/docs/collaborate/comment-replay', '/docs/collaborate/suggestions'])
  })

  it('gives every page its neighbours, across section borders', () => {
    const paths = (at: string) => docsPagerNeighbours(sections, at).map(page => page?.path ?? null)
    expect(paths('/docs/collaborate/comments')).toEqual(['/docs/collaborate/live-collab', '/docs/collaborate/comment-replay'])
    expect(paths('/docs/collaborate/comment-replay')).toEqual(['/docs/collaborate/comments', '/docs/collaborate/suggestions'])
    expect(paths('/docs/collaborate/suggestions')).toEqual(['/docs/collaborate/comment-replay', '/docs/sharing'])
    expect(paths('/docs/getting-started')).toEqual([null, '/docs/getting-started/quick-share'])
    expect(paths('/docs/self-hosting')).toEqual(['/docs/account/delete-account', null])
    expect(paths('/docs/nowhere')).toEqual([null, null])
    expect(docsPagerNeighbours(sections, '/docs/ai/overview')[0]?.title).toBe('AI assistant')
  })

  it('orders the search groups like the sidebar', () => {
    const tree = sortDocsNavTree(sections)
    expect(tree.map(section => section.path)).toEqual(DOCS_SECTIONS.map(slug => `/docs/${slug}`))
    expect(tree[2]?.children?.map(c => c.path).slice(0, 3)).toEqual(['/docs/ai', '/docs/ai/overview', '/docs/ai/prompt-bar'])
  })
})

describe('"Start here" on the docs landing page', () => {
  const featured = fs.readdirSync(DOCS_DIR, { recursive: true, encoding: 'utf8' })
    .filter(rel => rel.endsWith('.md') && frontmatter(rel).featured === 'true')
    .map(rel => `/docs/${rel.replace(/\.md$/, '')}`)

  it('features at most six pages, the ones a new reader needs first', () => {
    expect(featured.length).toBeLessThanOrEqual(6)
    expect([...featured].sort((a, b) => docsSectionIndex(a) - docsSectionIndex(b) || a.localeCompare(b))).toEqual([
      '/docs/getting-started/quick-share',
      '/docs/getting-started/templates',
      '/docs/writing/markdown-reference',
      '/docs/ai/overview',
      '/docs/sharing/read-only',
      '/docs/plans/limits'
    ])
  })
})
