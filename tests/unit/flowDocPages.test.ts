import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildFlowDocPages, docsRouteForFile, flowEmbedSlugs, resolveFlowDocPage } from '../../shared/docs/flowDocPages'
import { scanFlowDocPages } from '../../scripts/lib/flowDocPagesFs'

const FLOWS_DIR = path.resolve('tests/e2e/flows')
const DOCS_DIR = path.resolve('content/docs')

// Same slug rule as tests/e2e/fixtures/flow.ts: the test title becomes the slug.
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

function specSources(): Array<{ file: string, text: string }> {
  return fs.readdirSync(FLOWS_DIR)
    .filter(f => f.endsWith('.spec.ts'))
    .map(file => ({ file, text: fs.readFileSync(path.join(FLOWS_DIR, file), 'utf8') }))
}

describe('flowDocPages helpers', () => {
  it('extracts embedded flow slugs', () => {
    expect(flowEmbedSlugs('intro\n::flow{id="quick-share" hide-title}\n::flow{hide-title id="b"}')).toEqual(['quick-share', 'b'])
  })

  it('maps content files to /docs routes', () => {
    expect(docsRouteForFile('writing/comments.md')).toBe('/docs/writing/comments')
    expect(docsRouteForFile('writing/index.md')).toBe('/docs/writing')
  })

  it('first page (by path) wins for a flow embedded twice', () => {
    const map = buildFlowDocPages([
      { path: 'b/x.md', text: '::flow{id="f"}' },
      { path: 'a/y.md', text: '::flow{id="f"}' }
    ])
    expect(map.f).toBe('/docs/a/y')
  })

  it('resolves only known slugs', () => {
    expect(resolveFlowDocPage({ f: '/docs/a' }, 'f')).toBe('/docs/a')
    expect(resolveFlowDocPage({ f: '/docs/a' }, 'g')).toBeNull()
    expect(resolveFlowDocPage(undefined, 'f')).toBeNull()
  })
})

describe('every flow\'s "Try next" link lands on a docs page', () => {
  const map = scanFlowDocPages(DOCS_DIR)
  const nextRefs = specSources().flatMap(({ file, text }) =>
    Array.from(text.matchAll(/flow\.next\(\{\s*slug:\s*'([^']+)'/g), m => ({ file, slug: m[1] ?? '' }))
  )

  it('finds next links to check', () => {
    expect(nextRefs.length).toBeGreaterThan(20)
  })

  it.each(nextRefs)('$file → $slug', ({ slug }) => {
    expect(resolveFlowDocPage(map, slug)).toMatch(/^\/docs\//)
  })

  it('every embedded flow id is the slug of a real flow test', () => {
    const titles = new Set(specSources().flatMap(({ text }) =>
      Array.from(text.matchAll(/^test(?:\.\w+)?\(\s*'((?:[^'\\]|\\.)*)'/gm), m => slugify((m[1] ?? '').replaceAll('\\\'', '\'')))
    ))
    for (const slug of Object.keys(map)) {
      expect(titles, `docs embed "${slug}" has no flow test`).toContain(slug)
    }
  })
})
