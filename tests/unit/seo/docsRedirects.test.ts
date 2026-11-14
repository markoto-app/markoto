import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DOCS_REDIRECTS, docsRedirectRouteRules, docsRedirectTarget } from '../../../shared/docs/docsRedirects'
import { docsRouteForFile } from '../../../shared/docs/flowDocPages'

const DOCS_DIR = path.resolve('content/docs')

// Every /docs address that existed before the docs were regrouped into
// task-based sections (the tree of `main` at that point).
const PATHS_BEFORE = fs.readFileSync(path.resolve('tests/fixtures/docs/paths-before-regroup.txt'), 'utf8')
  .split('\n')
  .map(line => line.trim())
  .filter(Boolean)

function currentDocsPaths(): Set<string> {
  const files = fs.readdirSync(DOCS_DIR, { recursive: true, encoding: 'utf8' }).filter(rel => rel.endsWith('.md'))
  return new Set(files.map(docsRouteForFile))
}

describe('docs redirects', () => {
  const current = currentDocsPaths()

  it('knows the addresses from before the regrouping', () => {
    expect(PATHS_BEFORE.length).toBe(64)
    expect(PATHS_BEFORE).toContain('/docs/history')
  })

  it('has an entry for every old address that is no longer a page', () => {
    const missing = PATHS_BEFORE.filter(old => !current.has(old) && !(old in DOCS_REDIRECTS))
    expect(missing).toEqual([])
  })

  it('points every entry at an existing page, without chains', () => {
    const dangling = Object.entries(DOCS_REDIRECTS).filter(([, to]) => !current.has(to) || to in DOCS_REDIRECTS)
    expect(dangling).toEqual([])
  })

  it('never shadows an existing page', () => {
    expect(Object.keys(DOCS_REDIRECTS).filter(from => current.has(from))).toEqual([])
  })

  it('resolves an old address whatever query, hash or trailing slash it carries', () => {
    expect(docsRedirectTarget('/docs/account/plans')).toBe('/docs/plans/plans')
    expect(docsRedirectTarget('/docs/history/')).toBe('/docs/import-export')
    expect(docsRedirectTarget('/docs/writing/ai-budget?ref=mail#limits')).toBe('/docs/plans/ai-budget')
    expect(docsRedirectTarget('/docs/plans/plans')).toBeNull()
    expect(docsRedirectTarget('/docs/toString')).toBeNull()
  })

  it('becomes one permanent (301) route rule per old address', () => {
    const rules = docsRedirectRouteRules()
    expect(Object.keys(rules)).toEqual(Object.keys(DOCS_REDIRECTS))
    expect(rules['/docs/history']).toEqual({ redirect: { to: '/docs/import-export', statusCode: 301 } })
  })
})
